#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile

PRIMARY = "015D461F273E1B02B8E1A501B23FE28D2FAB39D0"
VERSION = "0.1.10-u4.8"
BASE_URL = f"https://u4.ibodrov.ca/releases/{VERSION}/"
NAMES = [f"U4-Code-{VERSION}-x86_64.AppImage", f"U4-Code-{VERSION}-arm64-v8a.apk", "receipt.json", "release-contract.json", "u4-release-signing-key.asc", "SHA256SUMS", "SHA256SUMS.asc"]
CLI = f"t3-{VERSION}-linux-x64.tar.gz"


def need(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    need(path.is_file() and not path.is_symlink(), "regular download file required")
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def netrc(path):
    file = Path(path)
    need(file.is_absolute() and file.is_file() and not file.is_symlink() and stat.S_IMODE(file.stat().st_mode) == 0o600, "netrc reference must be an absolute 0600 regular file")
    return file


def fetch(name, target, credentials, env):
    args = ["/usr/bin/curl", "--disable", "--silent", "--proto", "=https", "--proto-redir", "=https", "--max-redirs", "0", "--connect-timeout", "20", "--max-time", "600", "--output", str(target), "--write-out", "%{http_code}\n%{content_type}\n"]
    if credentials:
        args += ["--netrc", "--netrc-file", str(credentials)]
    args += [BASE_URL + name]
    result = subprocess.run(args, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True)
    need(result.returncode == 0, "private download transport failed; diagnostics suppressed to preserve credentials")
    status = result.stdout.splitlines()
    need(len(status) >= 1, "missing HTTP response status")
    return int(status[0]), (status[1] if len(status) > 1 else "").lower().split(";")[0].strip()


def verify(args):
    good, wrong = netrc(args.netrc), netrc(args.wrong_netrc)
    need(good != wrong, "independent wrong-auth netrc required")
    need(args.expected_primary == PRIMARY, "independent approved primary fingerprint required")
    output = Path(args.output_dir)
    need(output.is_absolute() and not output.exists(), "download output must be a fresh absolute directory")
    output.mkdir(mode=0o700)
    with tempfile.TemporaryDirectory(prefix="u4-download-") as temporary:
        home = Path(temporary)
        env = {"PATH": "/usr/bin:/bin", "HOME": temporary, "TMPDIR": temporary, "TMP": temporary, "TEMP": temporary, "LANG": "C.UTF-8"}
        observations = []
        for name in NAMES:
            status, mime = fetch(name, output / name, good, env)
            need(status == 200, "authenticated download did not return 200: " + name)
            if name.endswith(".apk"):
                need(mime == "application/vnd.android.package-archive", "APK MIME mismatch")
            observations.append({"file": name, "authenticatedStatus": status, "contentType": mime})
        for name, expected in [("release-contract.json", args.expected_contract_sha256), ("SHA256SUMS", args.expected_checksums_sha256), ("SHA256SUMS.asc", args.expected_signature_sha256)]:
            need(sha(output / name) == expected, "download differs from frozen producer digest: " + name)
        contract = json.loads((output / "release-contract.json").read_text())
        listed = [item["name"] for item in contract["files"]]
        need(sorted(listed) in [sorted(NAMES), sorted(NAMES + [CLI])], "unexpected private release file list")
        if CLI in listed:
            status, mime = fetch(CLI, output / CLI, good, env)
            need(status == 200, "CLI archive download failed")
            observations.append({"file": CLI, "authenticatedStatus": status, "contentType": mime})
        verified = subprocess.run([args.node, str(Path(__file__).with_name("finalize.mjs")), "verify", "--dir", str(output)], env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True)
        need(verified.returncode == 0, "download hash/signature/identity verification failed")
        verification = json.loads(verified.stdout)
        for item in observations:
            for label, credentials in [("absentAuth", None), ("wrongAuth", wrong)]:
                response = home / f"{label}-response"
                status, _ = fetch(item["file"], response, credentials, env)
                need(status == 401 and sha(response) != sha(output / item["file"]), "private URL auth negative failed")
                item[label + "Status"] = status
        evidence = {"schema": "u4-download-verification/1", "baseUrl": BASE_URL, "expectedPrimaryFingerprint": PRIMARY, **verification, "files": observations, "independentExternalVantage": "pending; no observer available", "serverLogCredentialRedaction": "requires separate Homelab evidence", "credentials": "file references only; no redirects followed"}
        evidence_path = Path(args.evidence)
        need(evidence_path.is_absolute() and not evidence_path.is_relative_to(output), "external evidence must be outside downloaded signed payload")
        with evidence_path.open("x") as stream:
            json.dump(evidence, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        print(json.dumps(evidence))


def main():
    parser = argparse.ArgumentParser()
    for name in ["netrc", "wrong-netrc", "expected-primary", "expected-contract-sha256", "expected-checksums-sha256", "expected-signature-sha256", "output-dir", "evidence"]:
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--node", default="/usr/bin/node")
    verify(parser.parse_args())


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
