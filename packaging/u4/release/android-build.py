#!/usr/bin/env python3
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("owned_process", HERE / "owned-process.py")
owned_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owned_module)
spec = importlib.util.spec_from_file_location("apk_inspect", HERE / "apk-inspect.py")
apk_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(apk_module)


def need(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    need(path.is_file() and not path.is_symlink(), "expected regular file: " + str(path))
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def capture(args, env, cwd=None):
    return subprocess.check_output(args, env=env, cwd=cwd, stdin=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True).strip()


def private_env(work, node_bin, jdk, sdk):
    values = {"HOME": work / "home", "TMPDIR": work / "tmp", "TMP": work / "tmp", "TEMP": work / "tmp", "XDG_CONFIG_HOME": work / "config", "XDG_CACHE_HOME": work / "cache", "XDG_DATA_HOME": work / "data", "XDG_STATE_HOME": work / "state", "XDG_RUNTIME_DIR": work / "run", "GRADLE_USER_HOME": work / "gradle"}
    for path in values.values():
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    env = {key: str(value) for key, value in values.items()}
    env.update({"PATH": f"{node_bin}:{jdk}/bin:/usr/bin:/bin", "JAVA_HOME": str(jdk), "ANDROID_HOME": str(sdk), "ANDROID_SDK_ROOT": str(sdk), "LANG": "C.UTF-8", "SHELL": "/bin/sh", "CI": "1", "EXPO_NO_TELEMETRY": "1", "EXPO_NO_DOTENV": "1", "NPM_CONFIG_USERCONFIG": "/dev/null", "NPM_CONFIG_GLOBALCONFIG": "/dev/null"})
    return env


def sdk_inventory(sdk):
    inventory = {}
    for group in ["build-tools", "ndk", "cmake", "platforms"]:
        directory = sdk / group
        inventory[group] = {package.name: {"revision": (package / "source.properties").read_text() if (package / "source.properties").is_file() else None} for package in sorted(directory.iterdir()) if package.is_dir()} if directory.is_dir() else {}
    return inventory


def require_unchanged_sdk(before, after):
    need(before == after, "SDK package inventory changed during Gradle; inspect additive changes before continuing")


def package_revision(sdk, package):
    match = re.search(r"^Pkg.Revision\s*=\s*(\S+)\s*$", (sdk / package / "source.properties").read_text(), re.M)
    need(match, "missing package revision: " + package)
    return match.group(1)


def native_build_inputs(source, sdk):
    expected_cmake = (sdk / "cmake/3.22.1/bin/cmake").resolve()
    expected_ndk = (sdk / "ndk/27.1.12297006").resolve()
    inputs = []
    for cache in sorted(source.rglob("CMakeCache.txt")):
        relative = cache.relative_to(source)
        probe_parts = relative.parts[-4:-1]
        if ".cxx" in relative.parts and probe_parts in [("CMakeFiles", "_CMakeLTOTest-CXX", "bin"), ("CMakeFiles", "_CMakeLTOTest-C", "bin")] and (cache.parents[3] / "CMakeCache.txt").is_file():
            continue
        values = dict(re.findall(r"^([^#/:=]+):[^=]+=([^\n]*)$", cache.read_text(), re.M))
        command = values.get("CMAKE_COMMAND", "")
        need(command and Path(command).resolve() == expected_cmake, "actual CMake differs from pinned SDK: " + str(cache))
        ndk = values.get("CMAKE_ANDROID_NDK") or values.get("ANDROID_NDK")
        compiler = values.get("CMAKE_CXX_COMPILER", "")
        toolchain = values.get("CMAKE_TOOLCHAIN_FILE", "")
        need((ndk and Path(ndk).resolve() == expected_ndk) or any(value and Path(value).resolve().is_relative_to(expected_ndk) for value in [compiler, toolchain]), "actual NDK differs or is unproven: " + str(cache))
        inputs.append({"cache": str(cache.relative_to(source)), "sha256": sha(cache), "cmakeCommand": command, "ndk": str(expected_ndk), "compiler": compiler, "toolchain": toolchain})
    need(inputs, "actual CMakeCache inputs missing")
    return inputs


def freeze_outputs(node, args, request, env, evidence_dir):
    paths = []
    for role in (["test", "release"] if args.role == "release" else ["test"]):
        evidence = evidence_dir / f"android-{role}.json"
        doc = json.loads(evidence.read_text())
        need(doc["sourceSha"] == request["sourceSha"] and doc["sourceTree"] == request["sourceTree"] and doc["versionCode"] == request["testCode" if role == "test" else "releaseCode"] and sha(Path(doc["file"])) == doc["sha256"], "immutable Android evidence conflict")
        paths.extend([Path(doc["file"]), evidence])
    update = dict(request, outputs=[{"file": str(path), "sha256": sha(path)} for path in paths])
    if args.role == "release":
        update["stage"] = "unsigned"
    capture([node, str(HERE / "finalize.mjs"), "reserve", "--record", args.record, "--request", json.dumps(update)], env)


def build(args):
    need(platform.system() == "Linux", "owned build process tracking requires Linux")
    for name in ["output_dir", "bundle", "node_bin", "jdk", "sdk", "record", "request_file"]:
        value = Path(getattr(args, name))
        need(value.is_absolute(), name + " must be absolute")
    output = Path(args.output_dir)
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    unsigned_dir = output / "unsigned"
    evidence_dir = output / "evidence"
    unsigned_dir.mkdir(mode=0o700, exist_ok=True)
    evidence_dir.mkdir(mode=0o700, exist_ok=True)
    node_bin, jdk, sdk = Path(args.node_bin), Path(args.jdk), Path(args.sdk)
    request = json.loads(Path(args.request_file).read_text())
    need(args.version == request["version"] and args.source_sha == request["sourceSha"] and args.source_tree == request["sourceTree"], "reservation/source identity mismatch")
    need(args.code == request["testCode" if args.role == "test" else "releaseCode"], "versionCode not reserved for role")
    node = str(node_bin / "node")
    bootstrap_env = {"PATH": f"{node_bin}:/usr/bin:/bin", "HOME": str(output), "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"}
    reservation = json.loads(capture([node, str(HERE / "finalize.mjs"), "reserve", "--record", args.record, "--request-file", args.request_file], bootstrap_env))
    need(reservation["stage"] in ["reserved", "unsigned", "signed", "accepted"], "reservation cannot build")
    final_name = f"U4-Code-{args.version}-arm64-v8a" + ("-t1" if args.role == "test" else "") + ".unsigned.apk"
    target = unsigned_dir / final_name
    result_file = evidence_dir / f"android-{args.role}.json"
    if result_file.exists():
        prior = json.loads(result_file.read_text())
        need(prior["sourceSha"] == args.source_sha and prior["sourceTree"] == args.source_tree and prior["bundleSha256"] == args.bundle_sha256 and prior["versionCode"] == args.code and prior["sha256"] == sha(target), "immutable Android replay conflict")
        if reservation["stage"] == "reserved":
            freeze_outputs(node, args, request, bootstrap_env, evidence_dir)
        print(json.dumps(prior))
        return
    need(reservation["stage"] == "reserved", "unsigned outputs already frozen; refusing rebuild")
    if args.role == "release":
        test_result = json.loads((evidence_dir / "android-test.json").read_text())
        need(test_result["versionCode"] == request["testCode"] and test_result["sourceSha"] == args.source_sha and test_result["sourceTree"] == args.source_tree and test_result["bundleSha256"] == args.bundle_sha256 and sha(Path(test_result["file"])) == test_result["sha256"], "test build must be completed first from same source")
    work = output / f"android-work-{args.role}"
    need(not work.exists() and not target.exists(), "interrupted Android scratch preserved; inspect it and use a fresh output directory or explicitly abandon the run")
    work.mkdir(mode=0o700)
    env = private_env(work, node_bin, jdk, sdk)
    need(capture([node, "--version"], env) == "v26.13.1", "Node 26.13.1 required")
    need(capture([str(node_bin / "pnpm"), "--version"], env) == "12.14.0", "pnpm 12.14.0 required")
    java = subprocess.run([str(jdk / "bin/java"), "-version"], env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, check=True).stderr.strip()
    need('"17.0.14"' in java, "JDK 17.0.14-tem required")
    need(jdk.name == "17.0.14-tem", "explicit Temurin JDK path required")
    for package, revision in [("build-tools/37.0.0", "37.0.0"), ("ndk/27.1.12297006", "27.1.12297006"), ("cmake/3.22.1", "3.22.1")]:
        properties = (sdk / package / "source.properties").read_text()
        need(re.search(r"Pkg.Revision\s*=\s*" + re.escape(revision) + r"\s*$", properties, re.M), "SDK revision mismatch: " + package)
    owned = owned_module.OwnedProcesses()
    log = evidence_dir / f"android-{args.role}.log"
    source = work / "source"
    try:
        owned.run([node, str(HERE / "finalize.mjs"), "export", "--bundle", args.bundle, "--bundle-sha256", args.bundle_sha256, "--source-sha", args.source_sha, "--source-tree", args.source_tree, "--ref", args.ref, "--output", str(source), "--wrappers", str(HERE)], cwd=work, env=env, log=log)
        owned.run([str(node_bin / "pnpm"), "install", "--frozen-lockfile", "--prod=false"], cwd=source, env=env, log=log)
        production = dict(env, APP_VARIANT="production", T3CODE_MOBILE_VERSION=args.version, U4CODE_ANDROID_VERSION_CODE=str(args.code), EXPO_NO_GIT_STATUS="1", NODE_ENV="production")
        mobile = source / "apps/mobile"
        owned.run([str(node_bin / "pnpm"), "exec", "expo", "prebuild", "--clean", "--platform", "android", "--no-install"], cwd=mobile, env=production, log=log)
        android = mobile / "android"
        build_gradle = (android / "app/build.gradle").read_text()
        releases = re.findall(r"\brelease\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}", build_gradle)
        need(releases and not re.search(r"\b(?:signingConfigs?|storeFile|storePassword|keyAlias|keyPassword)\b", build_gradle), "all signing configuration must be absent")
        for relative in ["app/build.gradle", "gradle/wrapper/gradle-wrapper.properties", "app/src/main/AndroidManifest.xml"]:
            shutil.copyfile(android / relative, evidence_dir / (args.role + "-" + relative.replace("/", "-")))
        (work / "gradle/gradle.properties").write_text("org.gradle.daemon=false\nkotlin.compiler.execution.strategy=in-process\nkotlin.daemon.enabled=false\nandroid.builder.sdkDownload=false\n")
        gradlew = str(android / "gradlew")
        gradle_flags = ["--no-daemon", "-Dorg.gradle.daemon=false", "-Dorg.gradle.workers.max=4", "-Pkotlin.compiler.execution.strategy=in-process", "-Dkotlin.daemon.enabled=false"]
        sdk_before = sdk_inventory(sdk)
        try:
            owned.run([gradlew, *gradle_flags, "--version"], cwd=android, env=production, log=log)
            owned.run([gradlew, *gradle_flags, "app:assembleRelease", "-PreactNativeArchitectures=arm64-v8a"], cwd=android, env=production, log=log)
            owned.run([gradlew, "--stop"], cwd=android, env=production, log=log)
        finally:
            sdk_after = sdk_inventory(sdk)
            (evidence_dir / f"android-{args.role}-sdk-inventory.json").write_text(json.dumps({"before": sdk_before, "after": sdk_after}, indent=2) + "\n")
            require_unchanged_sdk(sdk_before, sdk_after)
        native_inputs = native_build_inputs(source, sdk)
        built = android / "app/build/outputs/apk/release/app-release-unsigned.apk"
        build_tools = sdk / "build-tools/37.0.0"
        analyzer = sdk / "cmdline-tools/latest/bin/apkanalyzer"
        check_env = os.environ.copy()
        os.environ.clear()
        os.environ.update(production)
        try:
            inspection = apk_module.inspect(str(built), args.version, str(args.code), str(build_tools / "aapt2"), str(analyzer), str(build_tools / "zipalign"), False)
            unsigned = subprocess.run([str(build_tools / "apksigner"), "verify", str(built)], env=production, stdin=subprocess.DEVNULL, capture_output=True, text=True)
            need(unsigned.returncode != 0 and re.search(r"DOES NOT VERIFY|No signatures|Missing META-INF", unsigned.stderr + unsigned.stdout, re.I), "unsigned APK verification inconclusive or already signed")
        finally:
            os.environ.clear()
            os.environ.update(check_env)
        need(capture(["git", "status", "--porcelain", "--untracked-files=no"], env, source) == "", "build changed tracked source")
        with target.open("xb") as dst, built.open("rb") as src:
            shutil.copyfileobj(src, dst)
            dst.flush()
            os.fsync(dst.fileno())
        target.chmod(0o444)
        gradle_version = re.search(r"^Gradle (.+)$", log.read_text(), re.M)
        need(gradle_version, "actual Gradle version not recorded")
        agp_catalog = mobile / "node_modules/react-native/gradle/libs.versions.toml"
        need(agp_catalog.is_file(), "cannot determine installed RN Gradle catalog")
        agp = re.search(r'^agp\s*=\s*"([^"]+)"', agp_catalog.read_text(), re.M)
        need(agp, "actual AGP version missing")
        result = {"schema": "u4-android-build/1", "sourceSha": args.source_sha, "sourceTree": args.source_tree, "bundleSha256": args.bundle_sha256, "version": args.version, "versionCode": args.code, "role": args.role, "file": str(target), "sha256": sha(target), "inspection": inspection, "toolchain": {"host": platform.platform(), "node": "26.13.1", "pnpm": "12.14.0", "jdk": java, "buildTools": package_revision(sdk, "build-tools/37.0.0"), "ndk": package_revision(sdk, "ndk/27.1.12297006"), "cmake": package_revision(sdk, "cmake/3.22.1"), "nativeBuildInputs": native_inputs, "sdkInventory": {"before": sdk_before, "after": sdk_after}, "cmakeOutput": capture([str(sdk / "cmake/3.22.1/bin/cmake"), "--version"], env).splitlines()[0], "agp": agp.group(1), "gradle": gradle_version.group(1)}, "inputs": {"pnpmLockSha256": sha(source / "pnpm-lock.yaml")}, "ownedProcessesReaped": owned.reaped, "remainingOwnedChildren": owned.children()}
        need(not result["remainingOwnedChildren"], "owned build processes remain")
        with result_file.open("x") as stream:
            json.dump(result, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        result_file.chmod(0o444)
        freeze_outputs(node, args, request, env, evidence_dir)
        print(json.dumps(result))
    finally:
        owned.stop()


def main():
    parser = argparse.ArgumentParser()
    for name in ["bundle", "bundle-sha256", "source-sha", "source-tree", "ref", "version", "output-dir", "record", "request-file", "node-bin"]:
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--code", required=True, type=int)
    parser.add_argument("--role", required=True, choices=["test", "release"])
    parser.add_argument("--jdk", default="/home/ibodrov/.sdkman/candidates/java/17.0.14-tem")
    parser.add_argument("--sdk", default="/home/ibodrov/Android/Sdk")
    build(parser.parse_args())


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, KeyError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
