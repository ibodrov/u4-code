#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ ${HOME:-} == /work/home && ${U4_SOURCE_SHA:-} =~ ^[a-f0-9]{40}$ && ${U4_SOURCE_TREE:-} =~ ^[a-f0-9]{40}$ ]] || { echo 'Use linux-build.sh' >&2; exit 1; }
mkdir -p /work/home /work/tmp /work/run /work/xdg/{config,data,cache,state} /out/evidence /out/unsigned
chmod 700 /work/run
export TMP=/work/tmp TEMP=/work/tmp TMPDIR=/work/tmp XDG_RUNTIME_DIR=/work/run
export XDG_CONFIG_HOME=/work/xdg/config XDG_DATA_HOME=/work/xdg/data XDG_CACHE_HOME=/work/xdg/cache XDG_STATE_HOME=/work/xdg/state
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_COUNT=0
phase=prerequisites
trap 'rc=$?; printf "{\"phase\":\"%s\",\"exitCode\":%s}\n" "$phase" "$rc" > /out/evidence/linux-build-status.json' EXIT
exec > >(tee /out/evidence/linux-build.log) 2>&1
source /etc/os-release
[[ $ID == debian && $VERSION_ID == 12 && $VERSION_CODENAME == bookworm && $(dpkg --print-architecture) == amd64 ]]
[[ $(cat /etc/debian_version) == 12.15 ]]
cat /etc/debian_version > /out/evidence/debian-version.txt
cat /etc/os-release > /out/evidence/os-release
ldd --version > /out/evidence/glibc.txt
apt-get update
# python3 is the only bootstrap parser; all remaining inputs come from the verified export.
apt-get install -y --no-install-recommends python3 ca-certificates
mapfile -t packages < <(python3 -c 'import json; print("\n".join(json.load(open("/in/tools/linux-build-config.json"))["packages"]))')
apt-get install -y --no-install-recommends "${packages[@]}"
dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\t${source:Package}\t${source:Version}\n' > /out/evidence/debian-packages.tsv
cp /in/tools/linux-build-config.json /out/evidence/linux-build-config.json
python3 - <<'PY'
import json,subprocess,pathlib
c=json.load(open('/in/tools/linux-build-config.json'))
for name in ('node','rust'):
 t=c[name]; dest='/work/'+name+'.tar.xz'
 subprocess.run(['curl','--fail','--location','--proto','=https','--tlsv1.2','--output',dest,t['url']],check=True)
 import hashlib
 if hashlib.sha256(pathlib.Path(dest).read_bytes()).hexdigest()!=t['sha256']:raise SystemExit(name+' checksum mismatch')
subprocess.run(['mkdir','-p','/opt/node','/opt/rust','/work/rust-install'],check=True)
subprocess.run(['tar','-xJf','/work/node.tar.xz','--strip-components=1','-C','/opt/node'],check=True)
subprocess.run(['tar','-xJf','/work/rust.tar.xz','--strip-components=1','-C','/work/rust-install'],check=True)
subprocess.run(['/work/rust-install/install.sh','--prefix=/opt/rust','--without=rust-docs'],check=True)
PY
export PATH=/opt/node/bin:/opt/rust/bin:/usr/bin:/bin
[[ $(node --version) == v26.13.1 && $(rustc --version) == 'rustc 1.99.1 '* ]]
npm install --global pnpm@12.14.0
[[ $(pnpm --version) == 12.14.0 ]]
{ node --version; pnpm --version; rustc --version; cargo --version; git --version; patchelf --version; convert --version; } > /out/evidence/toolchains.txt
phase=source
[[ $(sha256sum /in/src.bundle | cut -d' ' -f1) == "$U4_BUNDLE_SHA256" ]]
git clone --no-checkout /in/src.bundle /work/src
cd /work/src
git checkout --detach "$U4_SOURCE_SHA"
[[ $(git rev-parse HEAD) == "$U4_SOURCE_SHA" && $(git rev-parse 'HEAD^{tree}') == "$U4_SOURCE_TREE" && -z $(git status --porcelain) ]]
git fsck --full --no-dangling
node /in/tools/linux-runtime-checks.mjs source /work/src
phase=dependencies
pnpm install --frozen-lockfile --prod=false
export PATH=/work/src/node_modules/.bin:$PATH
[[ -z $(git status --porcelain --untracked-files=normal) ]]
phase=version
node scripts/update-release-package-versions.ts "$U4_VERSION"
git diff --binary > /out/evidence/version-substitutions.patch
node /in/tools/linux-runtime-checks.mjs versions /work/src "$U4_VERSION"
export CARGO_BUILD_JOBS=4
phase=desktop
node scripts/build-desktop-artifact.ts --platform linux --target AppImage --arch x64 --build-version "$U4_VERSION" --output-dir /out/build/release
node /in/tools/linux-runtime-checks.mjs versions /work/src "$U4_VERSION"
git diff --binary | cmp - /out/evidence/version-substitutions.patch
phase=cli
# Restage explicitly: neither artifact depends on the other's manifest restore behavior.
node scripts/update-release-package-versions.ts "$U4_VERSION"
vp run --filter t3 build
node scripts/apply-web-brand-assets.ts production apps/server/dist/client
node apps/server/scripts/cli.ts build-exe --verbose
cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml --target x86_64-unknown-linux-gnu
mkdir -p /work/rm/linux-x64
cp native/resource-monitor/target/x86_64-unknown-linux-gnu/release/t3-resource-monitor /work/rm/linux-x64/
node scripts/build-cli-archive.ts --platform linux --arch x64 --version "$U4_VERSION" --resource-monitor-dir /work/rm --output-dir /out/build/release-cli
node /in/tools/linux-runtime-checks.mjs versions /work/src "$U4_VERSION"
git diff --binary | cmp - /out/evidence/version-substitutions.patch
mapfile -t images < <(find /out/build/release -maxdepth 1 -type f -name '*.AppImage')
[[ ${#images[@]} == 1 ]]
cp "${images[0]}" "/out/unsigned/U4-Code-$U4_VERSION-x86_64.AppImage"
cp "/out/build/release-cli/t3-$U4_VERSION-linux-x64.tar.gz" /out/unsigned/
phase=runtime
node /in/tools/linux-runtime-checks.mjs artifacts /work/src /out "$U4_VERSION" "$U4_SOURCE_SHA"
sha256sum /out/unsigned/* > /out/evidence/linux-unsigned-sha256.txt
phase=complete
