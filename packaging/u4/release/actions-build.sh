#!/usr/bin/env bash
set -euo pipefail
umask 077

tools=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
recipient=015D461F273E1B02B8E1A501B23FE28D2FAB39D0
source_ref=refs/heads/u4-actions-source

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

source_identity() {
  [[ ${GITHUB_SHA:-} =~ ^[a-f0-9]{40}$ && $(git rev-parse HEAD) == "$GITHUB_SHA" ]] ||
    fail "The checkout must match the dispatch commit."
  source_tree=$(git rev-parse 'HEAD^{tree}')
}

prepare() {
  local code
  [[ ${U4_VERSION:-} =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-u4\.(0|[1-9][0-9]*)$ ]] ||
    fail "Use a U4 version such as 0.1.10-u4.12."
  for code in "${U4_ANDROID_FLOOR:-}" "${U4_ANDROID_TEST_CODE:-}" "${U4_ANDROID_RELEASE_CODE:-}"; do
    [[ $code =~ ^(0|[1-9][0-9]{0,9})$ ]] || fail "Android codes must be decimal integers."
  done
  (( U4_ANDROID_FLOOR < U4_ANDROID_TEST_CODE && U4_ANDROID_TEST_CODE < U4_ANDROID_RELEASE_CODE &&
    U4_ANDROID_RELEASE_CODE < 2100000000 )) ||
    fail "Require floor < test code < release code <= 2099999999."
  [[ $(git rev-parse --is-shallow-repository) == false ]] || fail "Full Git history is required."
  [[ ${U4_NODE_BIN:-} == /* && -x $U4_NODE_BIN/node ]] || fail "Set U4_NODE_BIN to the absolute Node bin directory."
  [[ $("$U4_NODE_BIN/node" --version) == v26.13.1 ]] || fail "Node 26.13.1 is required."
  mkdir "$root"
  mkdir -m 700 "$root/gnupg" "$root/upload"
  gpg --homedir "$root/gnupg" --batch --import "$tools/actions-artifact-recipient.asc"
  local fingerprints
  fingerprints=$(gpg --homedir "$root/gnupg" --batch --with-colons --fingerprint |
    awk -F: '$1 == "pub" { primary = 1 } $1 == "fpr" && primary { print $10; primary = 0 }')
  [[ $fingerprints == "$recipient" ]] || fail "Unexpected artifact encryption key."

  git update-ref "$source_ref" "$GITHUB_SHA" ""
  "$U4_NODE_BIN/node" "$tools/finalize.mjs" bundle --repo "$PWD" --bundle "$bundle" \
    --source-sha "$GITHUB_SHA" --source-tree "$source_tree" --ref "$source_ref"
  local bundle_sha
  bundle_sha=$(sha256sum "$bundle" | cut -d' ' -f1)
  python3 - "$root" "$GITHUB_SHA" "$source_tree" "$bundle_sha" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import sys

root = Path(sys.argv[1])
source, tree, bundle = sys.argv[2:]
request = {
    "version": os.environ["U4_VERSION"],
    "sourceSha": source,
    "sourceTree": tree,
    "bundleSha256": bundle,
    "runId": f"gha-{os.environ['GITHUB_RUN_ID']}-{os.environ['GITHUB_RUN_ATTEMPT']}",
    "installedCode": int(os.environ["U4_ANDROID_FLOOR"]),
    "testCode": int(os.environ["U4_ANDROID_TEST_CODE"]),
    "releaseCode": int(os.environ["U4_ANDROID_RELEASE_CODE"]),
}
canonical_bytes = (json.dumps(request, sort_keys=True, separators=(",", ":")) + "\n").encode()
request["contractHash"] = hashlib.sha256(canonical_bytes).hexdigest()
(root / "request.json").write_text(json.dumps(request, indent=2) + "\n")
PY
}

seal_artifact() {
  local kind=$1
  shift
  local stage="$root/stage-$kind" sealed="$root/upload/$kind.tar.gz.gpg"
  mkdir "$stage"
  cp -- "$@" "$stage/"
  cp -- "$root/request.json" "$stage/build-inputs.json"
  (
    cd -- "$stage"
    sha256sum -- * > SHA256SUMS.tmp
    mv -- SHA256SUMS.tmp SHA256SUMS
    tar -czf - -- *
  ) | gpg --homedir "$root/gnupg" --batch --trust-model always --recipient "$recipient" \
    --encrypt --output "$sealed.partial"
  mv -- "$sealed.partial" "$sealed"
}

run_build() {
  local stage=$1 rc
  shift
  if "$@" >"$root/$stage.log" 2>&1; then
    printf '%s passed.\n' "$stage"
  else
    rc=$?
    printf '%s failed (exit %s). See %s.log on the runner.\n' "$stage" "$rc" "$stage" >&2
    return "$rc"
  fi
}

build_appimage() {
  run_build appimage "$tools/linux-build.sh" --bundle "$bundle" --bundle-sha256 "$bundle_sha" \
    --source-sha "$GITHUB_SHA" --source-tree "$source_tree" --version "$U4_VERSION" \
    --output-dir "$root/linux" || return
  seal_artifact appimage "$root/linux/unsigned/U4-Code-$U4_VERSION-x86_64.AppImage" \
    "$root/linux/evidence/linux-build-status.json"
}

build_android() {
  [[ ${U4_JAVA_HOME:-} == /* && ${U4_JAVA_HOME##*/} == 17.0.14-tem && -x $U4_JAVA_HOME/bin/java ]] ||
    fail "Set U4_JAVA_HOME to the absolute Temurin 17.0.14-tem directory."
  [[ ${ANDROID_HOME:-} == /* && -x $ANDROID_HOME/cmdline-tools/latest/bin/apkanalyzer ]] ||
    fail "Set ANDROID_HOME to the absolute SDK path with apkanalyzer."
  [[ $(PATH="$U4_NODE_BIN:$PATH" "$U4_NODE_BIN/pnpm" --version) == 12.14.0 ]] || fail "pnpm 12.14.0 is required."
  local -a args=(
    --bundle "$bundle" --bundle-sha256 "$bundle_sha" --source-sha "$GITHUB_SHA"
    --source-tree "$source_tree" --ref "$source_ref" --version "$U4_VERSION"
    --output-dir "$root/android" --record "$root/ci-reservations.json"
    --request-file "$root/request.json" --node-bin "$U4_NODE_BIN"
    --jdk "$U4_JAVA_HOME" --sdk "$ANDROID_HOME"
  )
  run_build android-test "$tools/android-build.sh" "${args[@]}" --role test --code "$U4_ANDROID_TEST_CODE" || return
  [[ -s $root/android/evidence/android-test.json &&
    -s $root/android/unsigned/U4-Code-$U4_VERSION-arm64-v8a-t1.unsigned.apk ]] ||
    fail "The Android test build did not leave its APK and receipt."
  df -h -- "$root"
  rm -rf -- "$root/android/android-work-test"
  run_build android-release "$tools/android-build.sh" "${args[@]}" --role release --code "$U4_ANDROID_RELEASE_CODE" || return
  df -h -- "$root"
  seal_artifact android "$root/android/unsigned/U4-Code-$U4_VERSION-arm64-v8a-t1.unsigned.apk" \
    "$root/android/unsigned/U4-Code-$U4_VERSION-arm64-v8a.unsigned.apk" \
    "$root/android/evidence/android-test.json" "$root/android/evidence/android-release.json"
}

main() {
  local ID= VERSION_ID=
  source /etc/os-release
  [[ $ID == ubuntu && $VERSION_ID == 24.04 && $(uname -m) == x86_64 ]] ||
    fail "Use the standard Ubuntu 24.04 x64 Actions runner."
  [[ ${GITHUB_RUN_ID:-} =~ ^[0-9]{1,20}$ && ${GITHUB_RUN_ATTEMPT:-} =~ ^[0-9]{1,10}$ &&
    ${RUNNER_TEMP:-} == /* ]] || fail "GitHub Actions run identity and absolute temp path are required."
  root=$RUNNER_TEMP/u4-build-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT
  bundle=$root/source.bundle
  source_identity
  if [[ ${1:-} == prepare ]]; then
    prepare
    return
  fi
  # Reuse the pinned request rather than hashing a potentially changed bundle as a new input.
  bundle_sha=$(sha256sum "$bundle" | cut -d' ' -f1)
  python3 - "$root/request.json" "$GITHUB_SHA" "$source_tree" "$bundle_sha" <<'PY'
import json
import os
from pathlib import Path
import sys

request = json.loads(Path(sys.argv[1]).read_text())
expected = {
    "sourceSha": sys.argv[2],
    "sourceTree": sys.argv[3],
    "bundleSha256": sys.argv[4],
    "version": os.environ["U4_VERSION"],
    "testCode": int(os.environ["U4_ANDROID_TEST_CODE"]),
    "releaseCode": int(os.environ["U4_ANDROID_RELEASE_CODE"]),
}
if any(request[key] != value for key, value in expected.items()):
    raise SystemExit("The prepared request does not match this build.")
PY
  case ${1:-} in
    appimage) build_appimage ;;
    android) build_android ;;
    *) fail "Use prepare, appimage or android." ;;
  esac
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
