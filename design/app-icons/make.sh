#!/bin/sh
# Renders the app icons of the web manifest from one logo mark SVG (viewBox 0 0 64 64).
#
#   design/app-icons/make.sh [mark.svg]
#
# Default input: design/logo-next/eyes/mark.svg, the logo of the app since 2026-11-18. To swap the
# logo, pass another mark. Needs `rsvg-convert`.
# Output goes to public/app-icons/. The names are referenced by public/manifest.webmanifest and by
# src/pages/next/shell.tsx (apple-touch-icon), so keep them:
#   icon-192.png            purpose "any", 192 px
#   icon-512.png            purpose "any", 512 px
#   icon-maskable-512.png   purpose "maskable", 512 px, mark inside the 80 % safe zone
#   apple-touch-icon.png    180 px, opaque (iOS rounds the corners)
# The icon background is the light chrome colour (--chrome in public/next/base.css). A manifest has
# one icon per size and no dark variant, so the icons use the light mark on the light background.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
mark=${1:-"$root/design/logo-next/eyes/mark.svg"}
out="$root/public/app-icons"
bg="#f2f4f6"
command -v rsvg-convert >/dev/null || { echo "rsvg-convert not found" >&2; exit 1; }
[ -f "$mark" ] || { echo "no such file: $mark" >&2; exit 1; }
# The mark without its outer <svg> element.
inner=$(tr '\n' ' ' < "$mark" | sed -e 's/^.*<svg[^>]*>//' -e 's#</svg>.*$##')
mkdir -p "$out"
compose() { # size of the mark in px (of 512), file
  size=$1
  shift
  offset=$(awk "BEGIN { print (512 - $size) / 2 }")
  scale=$(awk "BEGIN { print $size / 64 }")
  printf '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="%s"/><g transform="translate(%s %s) scale(%s)">%s</g></svg>' \
    "$bg" "$offset" "$offset" "$scale" "$inner"
}
compose 318 | rsvg-convert -w 512 -h 512 -o "$out/icon-512.png"
compose 318 | rsvg-convert -w 192 -h 192 -o "$out/icon-192.png"
compose 250 | rsvg-convert -w 512 -h 512 -o "$out/icon-maskable-512.png"
compose 330 | rsvg-convert -w 180 -h 180 -o "$out/apple-touch-icon.png"
ls -l "$out"
