#!/usr/bin/env python3
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("apk_inspect", HERE / "apk-inspect.py")
apk_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(apk_module)


def need(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    need(path.is_file() and not path.is_symlink(), "regular file required")
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def private_file(path):
    need(path.is_absolute() and path.is_file() and not path.is_symlink() and stat.S_IMODE(path.stat().st_mode) == 0o600, "key/password references must be absolute 0600 regular files")


def call(args, env, *, pass_fds=()):
    result = subprocess.run(args, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, pass_fds=pass_fds)
    need(result.returncode == 0, "signing tool failed; secret-bearing tool diagnostics suppressed")
    return result.stdout + result.stderr


def verify_signer(verification, expected_cert_sha256):
    certs = re.findall(r"^(?:Signer #\d+|V3\.0 Signer:) certificate SHA-256 digest: ([a-fA-F0-9]+)$", verification, re.M)
    need(len(certs) == 1 and certs[0].lower() == expected_cert_sha256, "APK certificate mismatch")
    need("Verified using v2 scheme (APK Signature Scheme v2): true" in verification and "Number of signers: 1" in verification and "CN=Android Debug" not in verification, "APK must verify with one non-debug v2 signer")


def freeze_outputs(node, args, request, env, output):
    artifacts = [output.parent / f"U4-Code-{request['version']}-arm64-v8a-t1.apk"]
    if args.role == "release":
        artifacts.append(output)
    paths = []
    for artifact in artifacts:
        evidence = artifact.with_suffix(".signature.json")
        doc = json.loads(evidence.read_text())
        need(doc["sourceSha"] == request["sourceSha"] and doc["sourceTree"] == request["sourceTree"] and doc["signedSha256"] == sha(artifact) and doc["certSha256"] == args.expected_cert_sha256 and doc["versionCode"] == request["testCode" if artifact.name.endswith("-t1.apk") else "releaseCode"], "immutable signed APK evidence conflict")
        paths.extend([artifact, evidence])
    update = dict(request, outputs=[{"file": str(path), "sha256": sha(path)} for path in paths])
    if args.role == "release":
        update["stage"] = "signed"
    call([node, str(HERE / "finalize.mjs"), "reserve", "--record", args.record, "--request", json.dumps(update)], env)


def main():
    parser = argparse.ArgumentParser()
    for name in ["unsigned", "unsigned-sha256", "output", "expected-cert-sha256", "keystore", "key-alias", "record", "request-file", "builds-stopped", "node-bin", "role"]:
        parser.add_argument("--" + name, required=True)
    password = parser.add_mutually_exclusive_group(required=True)
    password.add_argument("--password-file")
    password.add_argument("--password-fd", type=int)
    parser.add_argument("--sdk", default="/home/ibodrov/Android/Sdk")
    parser.add_argument("--jdk", default="/home/ibodrov/.sdkman/candidates/java/17.0.14-tem")
    args = parser.parse_args()
    need(args.role in ["test", "release"], "role must be test or release")
    request = json.loads(Path(args.request_file).read_text())
    code = request["testCode" if args.role == "test" else "releaseCode"]
    version = request["version"]
    unsigned, output, keystore = Path(args.unsigned), Path(args.output), Path(args.keystore)
    need(unsigned.is_absolute() and output.is_absolute(), "absolute artifact paths required")
    need(output.name == f"U4-Code-{version}-arm64-v8a" + ("-t1" if args.role == "test" else "") + ".apk", "signed APK name mismatch")
    need(sha(unsigned) == args.unsigned_sha256, "unsigned APK digest mismatch")
    private_file(keystore)
    need(re.fullmatch(r"[a-f0-9]{64}", args.expected_cert_sha256), "independent expected Android certificate digest required")
    proof = json.loads(Path(args.builds_stopped).read_text())
    need(proof.get("schema") == "u4-builds-stopped/1" and proof.get("runId") == request["runId"] and proof.get("sourceSha") == request["sourceSha"] and proof.get("sourceTree") == request["sourceTree"] and proof.get("allOwnedBuildsStopped") is True, "all-builds-stopped proof required before signing")
    need({item.get("kind") for item in proof.get("builds", [])} == {"linux", "android-test", "android-release"}, "both Android and Linux build completion records required")
    for item in proof["builds"]:
        path = Path(item["evidenceFile"])
        need(sha(path) == item["evidenceSha256"], "build completion evidence changed")
        doc = json.loads(path.read_text())
        need(doc.get("sourceSha") == request["sourceSha"] and doc.get("sourceTree") == request["sourceTree"] and doc.get("remainingOwnedChildren") == [], "build record lacks process-tree completion")
    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    release_root = Path(os.path.commonpath([output.parent.resolve(), unsigned.parent.resolve()]))
    need(release_root != Path("/") and not keystore.resolve().is_relative_to(release_root), "keystore must remain outside the common release build/sign tree")
    fd = None
    if args.password_file:
        password_path = Path(args.password_file)
        private_file(password_path)
        need(not password_path.resolve().is_relative_to(release_root), "password file must remain outside the release build/sign tree")
        fd = os.open(password_path, os.O_RDONLY)
    else:
        fd = args.password_fd
        need(fd is not None and fd >= 3, "password FD must be >=3")
        os.fstat(fd)
    work = Path(tempfile.mkdtemp(prefix=".u4-sign-", dir=output.parent))
    os.chmod(work, 0o700)
    env = {"PATH": f"{args.node_bin}:{args.jdk}/bin:/usr/bin:/bin", "JAVA_HOME": args.jdk, "HOME": str(work / "home"), "TMPDIR": str(work / "tmp"), "TMP": str(work / "tmp"), "TEMP": str(work / "tmp"), "XDG_CONFIG_HOME": str(work / "config"), "XDG_CACHE_HOME": str(work / "cache"), "XDG_DATA_HOME": str(work / "data"), "XDG_STATE_HOME": str(work / "state"), "XDG_RUNTIME_DIR": str(work / "run"), "LANG": "C.UTF-8"}
    for key in ["HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"]:
        Path(env[key]).mkdir(mode=0o700)
    tools = Path(args.sdk) / "build-tools/37.0.0"
    node = str(Path(args.node_bin) / "node")
    finalize = str(HERE / "finalize.mjs")
    original_env = dict(os.environ)
    try:
        os.environ.clear()
        os.environ.update(env)
        reservation = json.loads(call([node, finalize, "reserve", "--record", args.record, "--request-file", args.request_file], env))
        need(reservation["stage"] in ["unsigned", "signed", "accepted", "finalized"], "unsigned outputs not frozen")
        need(any(item["file"] == str(unsigned) and item["sha256"] == args.unsigned_sha256 for item in reservation["outputs"]), "APK not in immutable unsigned reservation")
        analyzer = str(Path(args.sdk) / "cmdline-tools/latest/bin/apkanalyzer")
        before = apk_module.inspect(str(unsigned), version, str(code), str(tools / "aapt2"), analyzer, str(tools / "zipalign"), False, archive_alignment=False)
        evidence_path = output.with_suffix(".signature.json")
        if output.exists() or evidence_path.exists():
            need(output.exists() and evidence_path.exists(), "interrupted signing output preserved; refuse overwrite")
            prior = json.loads(evidence_path.read_text())
            need(prior["unsignedSha256"] == args.unsigned_sha256 and prior["signedSha256"] == sha(output) and prior["certSha256"] == args.expected_cert_sha256 and prior["sourceSha"] == request["sourceSha"], "immutable signing replay conflict")
            if reservation["stage"] == "unsigned":
                freeze_outputs(node, args, request, env, output)
            print(json.dumps(prior))
            return
        need(reservation["stage"] == "unsigned", "signed stage cannot rebuild missing outputs")
        if args.role == "release":
            test_apk = output.parent / f"U4-Code-{version}-arm64-v8a-t1.apk"
            test_doc = json.loads(test_apk.with_suffix(".signature.json").read_text())
            need(test_doc["signedSha256"] == sha(test_apk) and test_doc["certSha256"] == args.expected_cert_sha256 and test_doc["versionCode"] == request["testCode"] and test_doc["sourceSha"] == request["sourceSha"], "signed test APK proof missing")
        aligned = work / "aligned.apk"
        call([str(tools / "zipalign"), "-P", "16", "-f", "4", str(unsigned), str(aligned)], env)
        candidate = work / "signed.apk"
        call([str(tools / "apksigner"), "sign", "--ks", str(keystore), "--ks-key-alias", args.key_alias, "--ks-pass", f"file:/dev/fd/{fd}", "--out", str(candidate), str(aligned)], env, pass_fds=(fd,))
        verification = call([str(tools / "apksigner"), "verify", "--verbose", "--print-certs", str(candidate)], env)
        verify_signer(verification, args.expected_cert_sha256)
        after = apk_module.inspect(str(candidate), version, str(code), str(tools / "aapt2"), analyzer, str(tools / "zipalign"), True)
        need(before["manifest"] == after["manifest"] and before["badging"] == after["badging"], "signing changed APK identity")
        with output.open("xb") as dst, candidate.open("rb") as src:
            shutil.copyfileobj(src, dst)
            dst.flush()
            os.fsync(dst.fileno())
        output.chmod(0o444)
        evidence = {"schema": "u4-apk-signature/1", "sourceSha": request["sourceSha"], "sourceTree": request["sourceTree"], "version": version, "versionCode": code, "role": args.role, "package": "ca.ibodrov.u4code", "unsignedSha256": args.unsigned_sha256, "signedSha256": sha(output), "certSha256": args.expected_cert_sha256, "file": str(output), "verification": verification, "inspection": after, "buildsStoppedSha256": sha(Path(args.builds_stopped))}
        with evidence_path.open("x") as stream:
            json.dump(evidence, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        evidence_path.chmod(0o444)
        freeze_outputs(node, args, request, env, output)
        print(json.dumps(evidence))
    finally:
        os.environ.clear()
        os.environ.update(original_env)
        if args.password_file and fd is not None:
            os.close(fd)
        shutil.rmtree(work)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
