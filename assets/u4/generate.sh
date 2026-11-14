#!/bin/sh
# Render every U4 Code icon raster from icon.svg. Run it after you change icon.svg or icon-dev.css.
# Needs rsvg-convert (librsvg) and node.
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for tool in rsvg-convert node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "generate.sh: $tool is not installed." >&2; exit 1; }
done

# render <variant> <size> <output> [extra rsvg-convert arguments]
render() {
  variant="$1"; size="$2"; output="$3"; shift 3
  if [ "$variant" = dev ]; then set -- --stylesheet "$here/icon-dev.css" "$@"; fi
  rsvg-convert "$@" --width "$size" --height "$size" "$here/icon.svg" --output "$output"
}

for variant in prod dev; do
  out="$here/$variant"
  mkdir -p "$out"
  render "$variant" 1024 "$out/icon-1024.png"
  # macOS wants an 824 px body with a 100 px transparent margin.
  render "$variant" 824 "$out/icon-macos-1024.png" --page-width 1024 --page-height 1024 --left 100 --top 100
  render "$variant" 16 "$out/favicon-16x16.png"
  render "$variant" 32 "$out/favicon-32x32.png"
  render "$variant" 180 "$out/apple-touch-icon.png"
  render "$variant" 192 "$out/icon-192x192.png"
  render "$variant" 512 "$out/icon-512x512.png"
  # Render each ICO size from the vector so the small sizes stay on the pixel grid.
  for size in 16 24 32 48 64 128 256; do render "$variant" "$size" "$tmp/$variant-$size.png"; done
  node "$here/pack-ico.mjs" "$out/favicon.ico" "$tmp/$variant-16.png" "$tmp/$variant-24.png" \
    "$tmp/$variant-32.png" "$tmp/$variant-48.png" "$tmp/$variant-64.png" "$tmp/$variant-128.png" \
    "$tmp/$variant-256.png"
done

# The web client serves the development set from its public folder. Builds copy the prod set over it.
for name in favicon.ico favicon-16x16.png favicon-32x32.png apple-touch-icon.png icon-192x192.png icon-512x512.png; do
  cp "$here/dev/$name" "$repo/apps/web/public/$name"
done

echo "Wrote $here/prod, $here/dev and the icons in apps/web/public."
