#!/usr/bin/env python3
import hashlib
import json
import struct
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile

ANDROID = "{http://schemas.android.com/apk/res/android}"
PACKAGE = "ca.ibodrov.u4code"


def need(condition, message):
    if not condition:
        raise ValueError(message)


def manifest_check(xml):
    root = ET.fromstring(xml)
    need(root.attrib.get("package") == PACKAGE, "APK package mismatch")
    application = root.find("application")
    need(application is not None, "missing application")
    need("com.t3tools" not in xml and "app.t3.codes" not in xml, "official identity in manifest")
    need("u.expo.dev" not in xml and "d763fcb8-d37c-41ea-a773-b54a0ab4a454" not in xml, "upstream OTA configuration")
    enabled = [node.attrib.get(ANDROID + "value") for node in application.findall("meta-data") if node.attrib.get(ANDROID + "name") == "expo.modules.updates.ENABLED"]
    need(enabled == ["false"], "Expo updates must explicitly be disabled")
    main = PACKAGE + ".MainActivity"
    receiver = "com.clerk.api.sso.SSOReceiverActivity"
    expected = sorted([
        (main, "u4code", ""), (main, "exp+u4code", ""),
        (main, "clerk", PACKAGE + ".hosted-callback"),
        (receiver, "clerk", PACKAGE + ".callback"),
        (receiver, "clerk", PACKAGE + ".oauth"),
    ])
    handlers = []
    for activity in application:
        for intent in activity.findall("intent-filter"):
            if not any(action.attrib.get(ANDROID + "name") == "android.intent.action.VIEW" for action in intent.findall("action")):
                continue
            need(activity.tag == "activity", "unexpected VIEW component")
            name = activity.attrib.get(ANDROID + "name", "")
            data = intent.findall("data")
            schemes = {node.attrib.get(ANDROID + "scheme") for node in data if ANDROID + "scheme" in node.attrib}
            hosts = {node.attrib.get(ANDROID + "host") for node in data if ANDROID + "host" in node.attrib}
            need(intent.attrib.get(ANDROID + "autoVerify") not in ["true", "1"], "unexpected autoVerify handler")
            need(all(set(node.attrib).issubset({ANDROID + "scheme", ANDROID + "host"}) for node in data), "unexpected VIEW data constraints")
            if schemes == {"clerk"}:
                need(len(hosts) == 1, "Clerk callback host mismatch")
            else:
                need(schemes and schemes.issubset({"u4code", "exp+u4code"}) and not hosts, "unexpected VIEW scheme/host")
            handlers.extend((name, scheme, next(iter(hosts)) if hosts else "") for scheme in schemes)
    need(sorted(handlers) == expected, "exact production VIEW handlers required")
    return {"package": PACKAGE, "schemes": sorted({scheme for _, scheme, _ in handlers}), "updatesEnabled": False, "viewHandlers": expected}



def elf_alignment(data, name):
    need(data[:6] == b"\x7fELF\x02\x01", "expected little-endian ELF64: " + name)
    need(struct.unpack_from("<H", data, 18)[0] == 183, "non-arm64 ELF: " + name)
    phoff = struct.unpack_from("<Q", data, 32)[0]
    entsize, count = struct.unpack_from("<HH", data, 54)
    loads = []
    for i in range(count):
        offset = phoff + i * entsize
        p_type, _, p_offset, vaddr, _, _, _, align = struct.unpack_from("<IIQQQQQQ", data, offset)
        if p_type == 1:
            need(align >= 16384 and (vaddr - p_offset) % 16384 == 0, "ELF PT_LOAD lacks 16KiB alignment: " + name)
            loads.append(align)
    need(loads, "ELF has no PT_LOAD: " + name)
    return min(loads)


def inspect(apk, version, code, aapt2, apkanalyzer, zipalign, signed, archive_alignment=True):
    xml = subprocess.check_output([apkanalyzer, "manifest", "print", apk], text=True)
    result = manifest_check(xml)
    root = ET.fromstring(xml)
    need(root.attrib.get(ANDROID + "versionName") == version, "APK versionName mismatch")
    need(root.attrib.get(ANDROID + "versionCode") == code, "APK versionCode mismatch")
    need(root.attrib.get(ANDROID + "compileSdkVersion") == "37", "compileSdk mismatch")
    sdk = root.find("uses-sdk")
    need(sdk is not None and sdk.attrib.get(ANDROID + "minSdkVersion") == "24" and sdk.attrib.get(ANDROID + "targetSdkVersion") == "36", "SDK range mismatch")
    badging = subprocess.check_output([aapt2, "dump", "badging", apk], text=True)
    need("native-code: 'arm64-v8a'" in badging and "native-code: 'arm64-v8a' '" not in badging, "native ABI mismatch")
    if archive_alignment:
        subprocess.run([zipalign, "-c", "-P", "16", "4", apk], check=True, stdout=subprocess.DEVNULL)
    with zipfile.ZipFile(apk) as archive:
        names = archive.namelist()
        need(len(names) == len(set(names)), "duplicate APK entries")
        native = [name for name in names if name.startswith("lib/") and name.endswith(".so")]
        need(native and all(name.startswith("lib/arm64-v8a/") for name in native), "unexpected native ABI set")
        result["nativeLibraries"] = [{"file": name, "minimumLoadAlignment": elf_alignment(archive.read(name), name)} for name in native]
        configs = [name for name in names if name in ["assets/app.config", "assets/app.config.json"]]
        need(len(configs) == 1, "one embedded Expo config required")
        config = json.loads(archive.read(configs[0]))
        if "expo" in config:
            config = config["expo"]
        need(config.get("updates", {}).get("enabled") is False, "embedded OTA must be disabled")
        need(not config.get("updates", {}).get("url"), "OTA URL must be absent")
        need(not config.get("owner") and not config.get("extra", {}).get("eas", {}).get("projectId"), "EAS owner/project must be absent")
        need(config.get("android", {}).get("package") == PACKAGE, "embedded package mismatch")
        need("u.expo.dev" not in json.dumps(config) and "d763fcb8-d37c-41ea-a773-b54a0ab4a454" not in json.dumps(config), "official OTA config embedded")
        if not signed:
            need(not any(name.upper().startswith("META-INF/") and name.upper().endswith((".RSA", ".DSA", ".EC")) for name in names), "signed APK supplied as unsigned")
    result.update({"versionName": version, "versionCode": int(code), "sha256": hashlib.file_digest(open(apk, "rb"), "sha256").hexdigest(), "badging": badging, "manifest": xml})
    return result


if __name__ == "__main__":
    try:
        if sys.argv[1] == "manifest":
            print(json.dumps(manifest_check(sys.stdin.read())))
        else:
            print(json.dumps(inspect(*sys.argv[2:8], sys.argv[8] == "signed"), indent=2))
    except (ValueError, ET.ParseError, KeyError, IndexError, subprocess.CalledProcessError, zipfile.BadZipFile, struct.error) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
