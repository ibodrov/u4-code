import importlib.util
import fcntl
import io
import json
import os
from pathlib import Path
import stat
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import patch

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent


def module(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), HERE / (name + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


android = module("android-build")
apk = module("apk-inspect")
signing = module("sign-apk")
download = module("verify-download")


class WrappersTest(unittest.TestCase):
    def test_actual_clerk_handlers_are_bound_to_their_activities(self):
        xml = '''<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="ca.ibodrov.u4code"><application>
          <meta-data android:name="expo.modules.updates.ENABLED" android:value="false"/>
          <activity android:name="ca.ibodrov.u4code.MainActivity">
            <intent-filter><action android:name="android.intent.action.VIEW"/><data android:scheme="u4code"/><data android:scheme="exp+u4code"/></intent-filter>
            <intent-filter><action android:name="android.intent.action.VIEW"/><data android:scheme="clerk" android:host="ca.ibodrov.u4code.hosted-callback"/></intent-filter>
          </activity>
          <activity android:name="com.clerk.api.sso.SSOReceiverActivity">
            <intent-filter><action android:name="android.intent.action.VIEW"/><data android:scheme="clerk" android:host="ca.ibodrov.u4code.callback"/></intent-filter>
            <intent-filter><action android:name="android.intent.action.VIEW"/><data android:scheme="clerk" android:host="ca.ibodrov.u4code.oauth"/></intent-filter>
          </activity>
        </application></manifest>'''
        self.assertEqual(apk.manifest_check(xml)["schemes"], ["clerk", "exp+u4code", "u4code"])
        for changed in [
            xml.replace("ca.ibodrov.u4code.callback", "untrusted.callback"),
            xml.replace("com.clerk.api.sso.SSOReceiverActivity", "ca.ibodrov.u4code.MainActivity"),
            xml.replace('android:scheme="exp+u4code"', 'android:scheme="t3code"'),
            xml.replace("ca.ibodrov.u4code.oauth", "ca.ibodrov.u4code.callback"),
            xml.replace('<data android:scheme="clerk" android:host="ca.ibodrov.u4code.oauth"/>', ''),
            xml.replace('<intent-filter>', '<intent-filter android:autoVerify="true">', 1),
            xml.replace("<application>", '<application android:debuggable="true">'),
            xml.replace("<application>", '<application android:testOnly="true">'),
            xml.replace("<application>", '<application android:isSplitRequired="true">'),
            xml.replace("<manifest ", '<manifest split="config.arm64_v8a" ', 1),
        ]:
            with self.assertRaises(ValueError):
                apk.manifest_check(changed)

    def test_android_release_requires_embedded_hermes_bytecode(self):
        for payload in (None, b"web JavaScript", bytes.fromhex("c61fbc03c103191f30000000"),
                        bytes.fromhex("c61fbc03c103191f30000000") + b"bytecode"):
            target = io.BytesIO()
            with zipfile.ZipFile(target, "w") as archive:
                if payload is not None:
                    archive.writestr("assets/index.android.bundle", payload)
            with zipfile.ZipFile(target) as archive:
                if payload is None or len(payload) <= 12 or payload.startswith(b"web"):
                    with self.assertRaises(ValueError):
                        apk.embedded_hermes_bundle(archive)
                else:
                    self.assertEqual(apk.embedded_hermes_bundle(archive)["hermesVersion"], 48)

    def test_signer_output_accepts_actual_build_tools_37_and_refuses_mismatches(self):
        digest = "ab" * 32
        footer = "Verified using v2 scheme (APK Signature Scheme v2): true\nNumber of signers: 1\n"
        legacy = footer + f"Signer #1 certificate SHA-256 digest: {digest}\nSigner #1 certificate DN: CN=U4 Code\n"
        modern = footer + f"V3.0 Signer: certificate SHA-256 digest: {digest}\nV3.0 Signer: certificate DN: CN=U4 Code\n"
        for output in [legacy, modern]:
            signing.verify_signer(output, digest)
            for changed in [output.replace(digest, "cd" * 32), output.replace("signers: 1", "signers: 2"), output.replace("CN=U4 Code", "CN=Android Debug"), output.replace("v2): true", "v2): false"), output + f"Signer #2 certificate SHA-256 digest: {digest}\n"]:
                with self.assertRaises(ValueError):
                    signing.verify_signer(changed, digest)

    def test_private_environment_discards_inherited_config_and_credentials(self):
        with tempfile.TemporaryDirectory(prefix="u4-wrapper-test-") as temporary:
            launchers = [f"CMAKE_{lang}_{kind}_LAUNCHER" for lang in ["C", "CXX"] for kind in ["COMPILER", "LINKER"]]
            with patch.dict(os.environ, dict.fromkeys(launchers, "/hostile;command") | {"NODE_OPTIONS": "--require /untrusted.cjs", "CMAKE_BUILD_PARALLEL_LEVEL": "99", "JAVA_TOOL_OPTIONS": "-Xmx32g", "GRADLE_OPTS": "--max-workers=99"}):
                env = android.private_env(Path(temporary), Path("/explicit/node"), Path("/explicit/jdk"), Path("/explicit/sdk"))
            self.assertFalse(set(env) & {"SSH_AUTH_SOCK", "GPG_AGENT_INFO", "DBUS_SESSION_BUS_ADDRESS", "JAVA_TOOL_OPTIONS", "GRADLE_OPTS", "NODE_ENV", "APP_VARIANT", "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY", "U4CODE_MOBILE_UPDATES_URL", "HTTP_PROXY"})
            self.assertEqual(env["NODE_OPTIONS"], "--max-old-space-size=1536")
            self.assertEqual(env["CMAKE_BUILD_PARALLEL_LEVEL"], "1")
            expected = [str(Path(sys.executable).resolve()), str(HERE / "native-build-limit.py"), str(Path(temporary) / "native-limit/command.lock")]
            for key in launchers:
                self.assertEqual(env.get(key), ";".join(expected))
            self.assertEqual(stat.S_IMODE(Path(expected[-1]).stat().st_mode), 0o600)
            self.assertEqual(env["PATH"], "/explicit/node:/explicit/jdk/bin:/usr/bin:/bin")
            for key in ["HOME", "TMP", "TEMP", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "GRADLE_USER_HOME"]:
                self.assertTrue(Path(env[key]).is_relative_to(temporary))
                self.assertEqual(stat.S_IMODE(Path(env[key]).stat().st_mode), 0o700)
            for suffix in ["bad;path", "bad path", "bad\npath", "bad$path", "bad\\path"]:
                with self.assertRaisesRegex(ValueError, "unsupported native launcher path"):
                    android.private_env(Path(temporary) / suffix, Path("/node"), Path("/jdk"), Path("/sdk"))

    def test_sdk_inventory_detects_packages_added_during_gradle(self):
        with tempfile.TemporaryDirectory(prefix="u4-sdk-inventory-") as temporary:
            sdk = Path(temporary)
            package = sdk / "cmake/3.22.1"
            package.mkdir(parents=True)
            (package / "source.properties").write_text("Pkg.Revision=3.22.1\n")
            before = android.sdk_inventory(sdk)
            android.require_unchanged_sdk(before, android.sdk_inventory(sdk))
            added = sdk / "cmake/3.30.5"
            added.mkdir()
            (added / "source.properties").write_text("Pkg.Revision=3.30.5\n")
            with self.assertRaisesRegex(ValueError, "SDK package inventory changed"):
                android.require_unchanged_sdk(before, android.sdk_inventory(sdk))

    def test_native_inputs_bind_cmake_and_ndk_to_actual_caches(self):
        with tempfile.TemporaryDirectory(prefix="u4-native-inputs-") as temporary:
            root = Path(temporary)
            sdk = root / "sdk"
            source = root / "source"
            cache = source / "module/.cxx/arm64-v8a/CMakeCache.txt"
            cache.parent.mkdir(parents=True)
            rules = cache.parent / "CMakeFiles/rules.ninja"
            rules.parent.mkdir()
            rules.write_text("rule CXX_COMPILER__tiny\nrule CXX_SHARED_LIBRARY_LINKER__tiny\n")
            cmake = sdk / "cmake/3.22.1/bin/cmake"
            compiler = sdk / "ndk/27.1.12297006/toolchains/llvm/bin/clang++"
            env = android.private_env(root / "work", Path("/node"), Path("/jdk"), sdk)
            original = f"CMAKE_COMMAND:INTERNAL={cmake}\nCMAKE_CXX_COMPILER:FILEPATH={compiler}\nANDROID_NDK:PATH={sdk}/ndk/27.1.12297006\nCMAKE_MAKE_PROGRAM:FILEPATH={sdk}/cmake/3.22.1/bin/ninja\n" + "".join(f"{key}:STRING={env[key]}\n" for key in android.NATIVE_LAUNCHERS)
            cache.write_text(original)
            launcher = env[android.NATIVE_LAUNCHERS[0]].replace(";", " ")
            commands = f"{launcher} {compiler} -c input.cpp -o input.o\n: && {launcher} {compiler} -shared input.o -o lib.so && :"
            probe = cache.parent / "CMakeFiles/_CMakeLTOTest-CXX/bin/CMakeCache.txt"
            probe.parent.mkdir(parents=True)
            probe.write_text(f"CMAKE_COMMAND:INTERNAL={cmake}\nCMAKE_PROJECT_NAME:STATIC=lto-test\n")
            with patch.object(android, "capture", return_value=commands):
                result = android.native_build_inputs(source, sdk, env)
            self.assertEqual(len(result), 1)
            self.assertEqual(result[0]["guardedCommands"], {"compile": 1, "link": 1})
            self.assertEqual(result[0]["cmakeCommand"], str(cmake))
            self.assertEqual(result[0]["ndk"], str(sdk / "ndk/27.1.12297006"))
            unknown = cache.parent / "CMakeFiles/unrecognized/bin/CMakeCache.txt"
            unknown.parent.mkdir(parents=True)
            unknown.write_text(probe.read_text())
            with patch.object(android, "capture", return_value=commands):
                with self.assertRaisesRegex(ValueError, "actual NDK"):
                    android.native_build_inputs(source, sdk, env)
            unknown.unlink()
            cache.write_text(f"CMAKE_COMMAND:INTERNAL={sdk}/cmake/3.30.5/bin/cmake\nCMAKE_CXX_COMPILER:FILEPATH={compiler}\n")
            with self.assertRaisesRegex(ValueError, "actual CMake"):
                android.native_build_inputs(source, sdk, env)
            cache.write_text(f"CMAKE_COMMAND:INTERNAL={cmake}\nCMAKE_CXX_COMPILER:FILEPATH={sdk}/ndk/other/bin/clang++\n")
            with self.assertRaisesRegex(ValueError, "actual NDK"):
                android.native_build_inputs(source, sdk, env)
            for key in ["CMAKE_CXX_COMPILER_LAUNCHER", "CMAKE_CXX_LINKER_LAUNCHER"]:
                cache.write_text(original.replace(f"{key}:STRING={env[key]}", f"{key}:STRING=/hostile"))
                with self.assertRaisesRegex(ValueError, "actual native launcher cache"):
                    android.native_build_inputs(source, sdk, env)
            cache.write_text(original)
            with patch.object(android, "capture", return_value=commands):
                cache.write_text(original.replace(f"CMAKE_CXX_COMPILER:FILEPATH={compiler}\n", ""))
                self.assertEqual(android.native_build_inputs(source, sdk, env)[0]["guardedCommands"]["link"], 1)
                cache.write_text(cache.read_text().replace("CMAKE_CXX_LINKER_LAUNCHER:STRING=", "MISSING:STRING="))
                with self.assertRaisesRegex(ValueError, "actual native launcher cache"):
                    android.native_build_inputs(source, sdk, env)
            cache.write_text(original)
            for changed in [commands.replace(launcher + " ", "", 1), commands.replace(": && " + launcher, ": && /hostile"), commands + f"\n{compiler.with_name('ld.lld')} -shared input.o -o bypass.so"]:
                with patch.object(android, "capture", return_value=changed):
                    with self.assertRaisesRegex(ValueError, "bypasses aggregate launcher"):
                        android.native_build_inputs(source, sdk, env)
            unknown_graph = source / "unrecognized/build.ninja"
            unknown_graph.parent.mkdir()
            unknown_graph.touch()
            with patch.object(android, "capture", return_value=commands):
                with self.assertRaisesRegex(ValueError, "no validated CMakeCache"):
                    android.native_build_inputs(source, sdk, env)

    def test_native_guard_preserves_argv_exit_signals_and_lock_after_launcher_death(self):
        with tempfile.TemporaryDirectory(prefix="u4-native-guard-") as temporary:
            root = Path(temporary)
            env = android.private_env(root / "work", Path("/node"), Path("/jdk"), Path("/sdk"))
            launcher = env[android.NATIVE_LAUNCHERS[0]].split(";")
            fixture = "import json,os,socket,sys; s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); s.sendall((json.dumps([os.getpid(),sys.argv[3:]])+'\\n').encode()); s.recv(1); sys.exit(int(sys.argv[2]))"
            owner = android.owned_module.OwnedProcesses()
            processes = []
            child_pids = []
            with socket.socket(socket.AF_UNIX) as server:
                server.bind(str(root / "socket"))
                server.listen()

                def start(code=0):
                    process = subprocess.Popen([*launcher, sys.executable, "-c", fixture, str(root / "socket"), str(code), "a b", ";$()", ""], env=env)
                    processes.append(process)
                    return process

                def accepted():
                    connection, _ = server.accept()
                    data = b""
                    while not data.endswith(b"\n"):
                        data += connection.recv(4096)
                    pid, argv = json.loads(data)
                    child_pids.append(pid)
                    self.assertEqual(argv, ["a b", ";$()", ""])
                    return connection

                def assert_locked_in_independent_process():
                    program = "import fcntl,sys; f=open(sys.argv[1]);\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(0)\nsys.exit(1)"
                    self.assertEqual(subprocess.run([sys.executable, "-c", program, launcher[-1]], env=env).returncode, 0)

                try:
                    first = start()
                    with accepted() as active:
                        waiting = start()
                        waiting.terminate()
                        self.assertEqual(waiting.wait(), -signal.SIGTERM)
                        second = start(37)
                        assert_locked_in_independent_process()
                        first.kill()
                        self.assertEqual(first.wait(), -signal.SIGKILL)
                        assert_locked_in_independent_process()
                        active.sendall(b"x")
                        self.assertEqual(os.waitpid(child_pids[-1], 0)[1], 0)
                    with accepted() as active:
                        assert_locked_in_independent_process()
                        active.sendall(b"x")
                    self.assertEqual(second.wait(), 37)
                    self.assertEqual(subprocess.run([*launcher, "/missing-native-command"], env=env, capture_output=True).returncode, 1)
                    third = start()
                    with accepted() as active:
                        third.terminate()
                        self.assertEqual(third.wait(), -signal.SIGTERM)
                        self.assertEqual(active.recv(1), b"")
                    fourth = start()
                    with accepted() as active:
                        os.kill(child_pids[-1], signal.SIGKILL)
                        self.assertEqual(fourth.wait(), -signal.SIGKILL)
                        self.assertEqual(active.recv(1), b"")
                    with open(launcher[-1]) as lock:
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    for hostile in [root / "missing", root / "symlink", root / "open-lock"]:
                        if hostile.name == "symlink":
                            hostile.symlink_to(launcher[-1])
                        elif hostile.name == "open-lock":
                            hostile.touch(mode=0o644)
                        self.assertEqual(subprocess.run([*launcher[:2], str(hostile), sys.executable, "-c", "raise AssertionError('must not run')"], env=env, capture_output=True).returncode, 1)
                finally:
                    for process in processes:
                        if process.poll() is None:
                            process.kill()
                        process.wait()
                    owner.stop()
                self.assertEqual(owner.children(), [])
                for pid in child_pids + [process.pid for process in processes]:
                    self.assertFalse(Path(f"/proc/{pid}").exists())

    def test_owned_orphan_is_reaped_without_name_matching(self):
        with tempfile.TemporaryDirectory(prefix="u4-process-test-") as temporary:
            root = Path(temporary)
            pid_file = root / "child.pid"
            script = root / "fixture.py"
            script.write_text("import os, signal, sys\nread, write = os.pipe()\npid = os.fork()\nif pid == 0:\n os.close(read)\n os.setsid()\n open(sys.argv[1], 'w').write(str(os.getpid()))\n os.write(write, b'1')\n os.close(write)\n signal.pause()\nelse:\n os.close(write)\n assert os.read(read, 1) == b'1'\n os.close(read)\n")
            owner = android.owned_module.OwnedProcesses()
            try:
                owner.run([sys.executable, str(script), str(pid_file)], cwd=root, env={"PATH": "/usr/bin:/bin"}, log=root / "log")
                child_pid = int(pid_file.read_text())
                self.assertFalse(Path(f"/proc/{child_pid}").exists())
                self.assertIn(child_pid, [child["pid"] for child in owner.reaped])
                self.assertEqual(owner.children(), [])
            finally:
                owner.stop()

    def test_native_page_alignment_checks_actual_load_segments(self):
        data = bytearray(128)
        data[:6] = b"\x7fELF\x02\x01"
        struct.pack_into("<H", data, 18, 183)
        struct.pack_into("<Q", data, 32, 64)
        struct.pack_into("<HH", data, 54, 56, 1)
        struct.pack_into("<IIQQQQQQ", data, 64, 1, 5, 0, 0, 0, 128, 128, 16384)
        self.assertEqual(apk.elf_alignment(data, "fixture.so"), 16384)
        struct.pack_into("<Q", data, 64 + 48, 4096)
        with self.assertRaisesRegex(ValueError, "16KiB"):
            apk.elf_alignment(data, "fixture.so")
        struct.pack_into("<Q", data, 64 + 48, 16384)
        struct.pack_into("<Q", data, 64 + 16, 4096)
        with self.assertRaisesRegex(ValueError, "16KiB"):
            apk.elf_alignment(data, "fixture.so")
        struct.pack_into("<H", data, 18, 62)
        with self.assertRaisesRegex(ValueError, "arm64"):
            apk.elf_alignment(data, "fixture.so")

    def test_file_secret_references_refuse_open_permissions_and_symlinks(self):
        with tempfile.TemporaryDirectory(prefix="u4-reference-test-") as temporary:
            root = Path(temporary)
            reference = root / "reference"
            reference.write_text("inert fixture, no credential")
            reference.chmod(0o644)
            for check in [signing.private_file, download.netrc]:
                with self.assertRaisesRegex(ValueError, "0600"):
                    check(reference)
            reference.chmod(0o600)
            signing.private_file(reference)
            download.netrc(reference)
            linked = root / "linked"
            linked.symlink_to(reference)
            for check in [signing.private_file, download.netrc]:
                with self.assertRaisesRegex(ValueError, "0600"):
                    check(linked)


if __name__ == "__main__":
    unittest.main()
