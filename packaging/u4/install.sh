#!/bin/sh
# Install the newest local U4 Code AppImage for the current user.
# It writes only U4 paths and does not touch official T3 Code files.
set -eu

repo="$(cd "$(dirname "$0")/../.." && pwd)"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
bin="${U4CODE_BIN_DIR:-$HOME/.local/bin}"

source_image="${1:-$(ls -t "$repo"/release/U4-Code-*-x86_64.AppImage 2>/dev/null | head -n 1)}"
if [ -z "$source_image" ] || [ ! -f "$source_image" ]; then
  echo "install.sh: no U4-Code-*-x86_64.AppImage in $repo/release. Build it first." >&2
  exit 1
fi

mkdir -p "$data/u4code" "$bin" "$data/applications" "$data/icons/hicolor/512x512/apps"
install -m 0755 "$source_image" "$data/u4code/U4-Code.AppImage.new"
mv -f "$data/u4code/U4-Code.AppImage.new" "$data/u4code/U4-Code.AppImage"
install -m 0755 "$repo/packaging/u4/u4code" "$bin/u4code"

icon="$data/icons/hicolor/512x512/apps/u4code.png"
if command -v magick >/dev/null 2>&1; then
  # A hue shift keeps the upstream shape but makes U4 easy to tell apart from T3.
  magick "$repo/assets/prod/black-universal-1024.png" -resize 512x512 -modulate 100,100,160 \
    -fill '#2563eb' -colorize 35 "$icon"
else
  install -m 0644 "$repo/assets/prod/black-universal-1024.png" "$icon"
fi

cat >"$data/applications/u4code.desktop" <<EOF
[Desktop Entry]
Name=U4 Code
Comment=Local fork of T3 Code
Exec=$bin/u4code %U
TryExec=$bin/u4code
Terminal=false
Type=Application
Icon=u4code
StartupWMClass=ca.ibodrov.U4Code
Categories=Development;
MimeType=x-scheme-handler/u4code;
EOF

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$data/applications" || true
echo "Installed $data/u4code/U4-Code.AppImage from $source_image"
echo "Launcher: $bin/u4code"
