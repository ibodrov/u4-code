import importlib.util
import os
from pathlib import Path
import stat
import struct
import sys
import tempfile
import unittest

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
        ]:
            with self.assertRaises(ValueError):
                apk.manifest_check(changed)

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
            env = android.private_env(Path(temporary), Path("/explicit/node"), Path("/explicit/jdk"), Path("/explicit/sdk"))
            self.assertFalse(set(env) & {"SSH_AUTH_SOCK", "GPG_AGENT_INFO", "DBUS_SESSION_BUS_ADDRESS", "NODE_OPTIONS", "JAVA_TOOL_OPTIONS", "GRADLE_OPTS", "NODE_ENV", "APP_VARIANT", "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY", "U4CODE_MOBILE_UPDATES_URL", "HTTP_PROXY"})
            self.assertEqual(env["PATH"], "/explicit/node:/explicit/jdk/bin:/usr/bin:/bin")
            for key in ["HOME", "TMP", "TEMP", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "GRADLE_USER_HOME"]:
                self.assertTrue(Path(env[key]).is_relative_to(temporary))
                self.assertEqual(stat.S_IMODE(Path(env[key]).stat().st_mode), 0o700)

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
            cmake = sdk / "cmake/3.22.1/bin/cmake"
            compiler = sdk / "ndk/27.1.12297006/toolchains/llvm/bin/clang++"
            cache.write_text(f"CMAKE_COMMAND:INTERNAL={cmake}\nCMAKE_CXX_COMPILER:FILEPATH={compiler}\n")
            probe = cache.parent / "CMakeFiles/_CMakeLTOTest-CXX/bin/CMakeCache.txt"
            probe.parent.mkdir(parents=True)
            probe.write_text(f"CMAKE_COMMAND:INTERNAL={cmake}\nCMAKE_PROJECT_NAME:STATIC=lto-test\n")
            result = android.native_build_inputs(source, sdk)
            self.assertEqual(len(result), 1)
            self.assertEqual(result[0]["cmakeCommand"], str(cmake))
            self.assertEqual(result[0]["ndk"], str(sdk / "ndk/27.1.12297006"))
            unknown = cache.parent / "CMakeFiles/unrecognized/bin/CMakeCache.txt"
            unknown.parent.mkdir(parents=True)
            unknown.write_text(probe.read_text())
            with self.assertRaisesRegex(ValueError, "actual NDK"):
                android.native_build_inputs(source, sdk)
            unknown.unlink()
            cache.write_text(f"CMAKE_COMMAND:INTERNAL={sdk}/cmake/3.30.5/bin/cmake\nCMAKE_CXX_COMPILER:FILEPATH={compiler}\n")
            with self.assertRaisesRegex(ValueError, "actual CMake"):
                android.native_build_inputs(source, sdk)
            cache.write_text(f"CMAKE_COMMAND:INTERNAL={cmake}\nCMAKE_CXX_COMPILER:FILEPATH={sdk}/ndk/other/bin/clang++\n")
            with self.assertRaisesRegex(ValueError, "actual NDK"):
                android.native_build_inputs(source, sdk)

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
