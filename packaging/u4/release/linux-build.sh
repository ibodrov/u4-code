#!/usr/bin/env bash
set -euo pipefail
umask 077
bundle= bundle_sha= source_sha= source_tree= version= output=
while (($#)); do
  (($# >= 2)) || { echo 'Every option requires a value' >&2; exit 2; }
  case "$1" in
    --bundle) bundle=$2;;
    --bundle-sha256) bundle_sha=$2;;
    --source-sha) source_sha=$2;;
    --source-tree) source_tree=$2;;
    --version) version=$2;;
    --output-dir) output=$2;;
    *) echo "Unknown option: $1" >&2; exit 2;;
  esac
  shift 2
done
[[ $bundle_sha =~ ^[a-f0-9]{64}$ && $source_sha =~ ^[a-f0-9]{40}$ && $source_tree =~ ^[a-f0-9]{40}$ && $version =~ ^[0-9]+\.[0-9]+\.[0-9]+-u4\.[0-9]+$ && -n $output ]] || { echo 'Required: --bundle PATH --bundle-sha256 SHA256 --source-sha SHA --source-tree TREE --version VERSION --output-dir PATH' >&2; exit 2; }
[[ -f $bundle && ! -L $bundle ]] || { echo 'Bundle must be a regular file' >&2; exit 1; }
bundle=$(realpath "$bundle")
tools=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
mkdir -p -- "$output"
output=$(realpath "$output")
[[ -z $(find "$output" -mindepth 1 -print -quit) ]] || { echo 'Output directory must be empty' >&2; exit 1; }
[[ $(sha256sum -- "$bundle" | cut -d' ' -f1) == "$bundle_sha" ]] || { echo 'Bundle checksum mismatch' >&2; exit 1; }
scratch=$(mktemp -d)
container_pid=
cleanup() {
  if [[ -s $scratch/container.cid ]]; then
    cid=$(cat "$scratch/container.cid")
    if [[ $cid =~ ^[a-f0-9]{64}$ ]]; then podman rm --force --time 10 "$cid" >/dev/null 2>&1 || true; fi
  fi
  if [[ -n $container_pid ]]; then kill -TERM "$container_pid" 2>/dev/null || true; wait "$container_pid" || true; fi
  rm -rf -- "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# An empty Git config prevents host aliases, templates and hooks from affecting verification.
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
export GIT_CONFIG_COUNT=0
git init -q "$scratch/repo"
git -C "$scratch/repo" bundle verify "$bundle"
mapfile -t tips < <(git bundle list-heads "$bundle")
[[ ${#tips[@]} == 1 && ${tips[0]} == "$source_sha refs/heads/"* ]] || { echo 'Bundle must have one named branch tip at the expected commit' >&2; exit 1; }
git -C "$scratch/repo" fetch -q "$bundle" "${tips[0]#* }"
[[ $(git -C "$scratch/repo" rev-parse 'FETCH_HEAD^{tree}') == "$source_tree" ]] || { echo 'Source tree mismatch' >&2; exit 1; }
git -C "$scratch/repo" fsck --full --no-dangling
# Compare the complete tools export, including files belonging to other release slices.
git -C "$scratch/repo" archive "$source_sha" packaging/u4/release | tar -xf - -C "$scratch"
diff -qr --no-dereference "$scratch/packaging/u4/release" "$tools"
[[ -z $(find "$tools" -type l -print -quit) ]] || { echo 'Wrapper export must contain no symlinks' >&2; exit 1; }
image=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["image"]["reference"])' "$tools/linux-build-config.json")
[[ $image == docker.io/library/debian@sha256:* ]] || { echo 'Only pinned official Debian is allowed' >&2; exit 1; }
podman run --rm --cidfile "$scratch/container.cid" --pull=missing --arch amd64 --memory=14g --cpus=6 --pids-limit=2048 \
  --http-proxy=false --security-opt=no-new-privileges --tmpfs /tmp:rw,size=2g --shm-size=256m \
  --mount "type=bind,src=$bundle,dst=/in/src.bundle,ro" \
  --mount "type=bind,src=$tools,dst=/in/tools,ro" \
  --mount "type=bind,src=$output,dst=/out,rw" \
  --entrypoint /usr/bin/env "$image" -i \
  PATH=/usr/bin:/bin HOME=/work/home TMP=/tmp TEMP=/tmp TMPDIR=/tmp \
  LANG=C.UTF-8 SHELL=/bin/bash U4_SOURCE_SHA="$source_sha" U4_SOURCE_TREE="$source_tree" \
  U4_BUNDLE_SHA256="$bundle_sha" U4_VERSION="$version" \
  /bin/bash /in/tools/linux-container.sh &
container_pid=$!
wait "$container_pid"
container_pid=
podman version --format json > "$output/evidence/podman-version.json"
podman image inspect "$image" > "$output/evidence/container-image.json"
