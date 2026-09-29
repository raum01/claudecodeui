#!/usr/bin/env bash
#
# Build the macOS desktop app for one self-hosted CloudCLI server, from Linux.
#
# The app is upstream's Electron shell with the server URL built in
# (electron/selfHostedServer.js); on start it opens that server in a tab.
# Output is a .zip per architecture, ad-hoc signed, not notarized:
#
#   release/desktop/<productName>-<version>-mac-<arch>.zip
#   release/desktop/SHASUMS256-mac-selfhosted.txt
#
# What this cannot do off a Mac, by Apple's design:
#   - Developer ID signing and notarization (needs an Apple Developer account;
#     upstream's CI does it on macOS runners with its own certificate);
#   - a .dmg (electron-builder builds DMGs only on macOS).
#
# Usage:
#   CLOUDCLI_DESKTOP_BUNDLED_SERVER_URL=https://cloudcli.example.com \
#     scripts/release/build-desktop-mac-selfhosted.sh [arm64] [x64]
#
# Environment:
#   CLOUDCLI_DESKTOP_BUNDLED_SERVER_URL  required; the server the app opens
#   CLOUDCLI_DESKTOP_APP_ID   bundle id, default ai.cloudcli.desktop.selfhosted, so
#                             this build does not collide with the official app
#   RCODESIGN                 path to rcodesign (apple-codesign), default: from PATH
#   SKIP_WEB_BUILD=1          reuse an existing dist/ instead of `npm run build`
#   DESKTOP_BUILD_DIR         scratch directory for the unpacked .app, default
#                             $XDG_CACHE_HOME/cloudcli-desktop-mac (must be a
#                             POSIX filesystem, see below)
#
# Why the zip is made here and not by electron-builder: on Linux its mac zip
# target stores the symlinks inside Electron Framework.framework as copies
# (measured: 0 symlink entries), which breaks the framework layout and its
# signature seal. Info-ZIP with -y stores them as links. The .app is also
# assembled outside the repository because a FUSE/NTFS checkout reports every
# file as mode 777, and those modes would ship inside the zip.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

log() { printf '[build-desktop-mac] %s\n' "$*" >&2; }
die() { printf '[build-desktop-mac] ERROR: %s\n' "$*" >&2; exit 1; }

[ -n "${CLOUDCLI_DESKTOP_BUNDLED_SERVER_URL:-}" ] || die "set CLOUDCLI_DESKTOP_BUNDLED_SERVER_URL to the server the app should open"
export CLOUDCLI_DESKTOP_BUNDLED_SERVER_URL
APP_ID="${CLOUDCLI_DESKTOP_APP_ID:-ai.cloudcli.desktop.selfhosted}"
RCODESIGN="${RCODESIGN:-$(command -v rcodesign || true)}"
[ -n "$RCODESIGN" ] && [ -x "$RCODESIGN" ] \
  || die "rcodesign not found; set RCODESIGN or put it on PATH (https://github.com/indygreg/apple-platform-rs/releases)"
export RCODESIGN
[ -d node_modules/electron-builder ] || die "run npm ci first"
command -v zip >/dev/null || die "Info-ZIP zip is required"
BUILD_DIR="${DESKTOP_BUILD_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/cloudcli-desktop-mac}"

ARCHES=("$@")
[ "${#ARCHES[@]}" -gt 0 ] || ARCHES=(arm64 x64)
ARCH_FLAGS=()
for arch in "${ARCHES[@]}"; do
  case "$arch" in
    arm64|x64) ARCH_FLAGS+=("--$arch") ;;
    *) die "unsupported architecture: $arch (use arm64 and/or x64)" ;;
  esac
done

if [ "${SKIP_WEB_BUILD:-0}" != "1" ]; then
  log "building the web client"
  npm run build
fi

log "staging the desktop app for $CLOUDCLI_DESKTOP_BUNDLED_SERVER_URL"
npm run desktop:stage

STAGED_CONFIG=".desktop-build/desktop-app/electron/self-hosted-server.json"
[ -f "$STAGED_CONFIG" ] || die "staging did not write $STAGED_CONFIG"
log "bundled config: $(tr -d '\n ' < "$STAGED_CONFIG")"

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
log "packaging ${ARCHES[*]} into $BUILD_DIR (app id $APP_ID)"
npx --no-install electron-builder \
  --projectDir .desktop-build/desktop-app \
  --mac dir "${ARCH_FLAGS[@]}" \
  --publish never \
  -c.appId="$APP_ID" \
  -c.directories.output="$BUILD_DIR" \
  -c.mac.notarize=false \
  -c.mac.identity=null \
  -c.afterPack="$ROOT/scripts/release/adhoc-sign-mac.cjs"

VERSION="$(node -p 'require("./.desktop-build/desktop-app/package.json").version')"
PRODUCT="$(node -p 'require("./.desktop-build/desktop-app/package.json").build.productName')"
OUT_DIR="$ROOT/release/desktop"
mkdir -p "$OUT_DIR"
ZIPS=()
for arch in "${ARCHES[@]}"; do
  # electron-builder names the x64 output directory plain "mac".
  app_parent="$BUILD_DIR/mac-$arch"
  [ "$arch" = "x64" ] && [ ! -d "$app_parent" ] && app_parent="$BUILD_DIR/mac"
  [ -d "$app_parent/$PRODUCT.app" ] || die "expected $app_parent/$PRODUCT.app was not produced"
  app="$app_parent/$PRODUCT.app"
  links="$(find "$app" -type l | wc -l)"
  [ "$links" -gt 0 ] || die "$app contains no symlinks; the framework layout is broken"

  # Checked here as well as in the afterPack hook, so a hook that silently did
  # not run cannot produce an unsigned zip that exits 0.
  main_exe="$app/Contents/MacOS/$PRODUCT"
  want_arch="$([ "$arch" = arm64 ] && echo arm64 || echo x86_64)"
  # Outputs are captured before matching: `producer | grep -q` under pipefail
  # can fail on a good build when grep exits early and the producer gets SIGPIPE.
  main_kind="$(file -b "$main_exe")"
  [[ "$main_kind" == *"Mach-O 64-bit $want_arch executable"* ]] \
    || die "$main_exe is not a $want_arch executable: $main_kind"
  signed=0
  while IFS= read -r -d '' exe; do
    sig_info="$("$RCODESIGN" print-signature-info "$exe" 2>&1)" || die "rcodesign cannot read $exe: $sig_info"
    [[ "$sig_info" == *'CodeSignatureFlags(ADHOC)'* ]] || die "$exe is not ad-hoc signed"
    signed=$((signed + 1))
  done < <(find "$app" -path '*.app/Contents/MacOS/*' -type f -print0)
  # The main executable plus at least one helper; zero would mean nothing was checked.
  [ "$signed" -ge 2 ] || die "only $signed executables found to check under $app"
  [ -z "$(find "$app" -perm -o+w -not -type l -print -quit)" ] || die "$app contains world-writable files"
  log "$arch: $want_arch, $signed executables ad-hoc signed, $links symlinks"

  zip_name="cloudcli-desktop-$VERSION-mac-$arch.zip"
  rm -f "$OUT_DIR/$zip_name"
  (cd "$app_parent" && zip -qry -X "$OUT_DIR/$zip_name" "$PRODUCT.app")
  zip_listing="$(zipinfo "$OUT_DIR/$zip_name")"
  stored_links="$(grep -c '^l' <<< "$zip_listing" || true)"
  [ "$stored_links" -eq "$links" ] || die "$zip_name stores $stored_links symlinks, the app has $links"
  main_entry="$(zipinfo "$OUT_DIR/$zip_name" "$PRODUCT.app/Contents/MacOS/$PRODUCT")"
  [[ "$main_entry" == -rwx* ]] || die "$zip_name stores the main executable without its executable bit: $main_entry"
  log "$zip_name: $links symlinks stored as links"
  ZIPS+=("$zip_name")
done

cd "$OUT_DIR"
sha256sum "${ZIPS[@]}" > SHASUMS256-mac-selfhosted.txt
log "done, in $OUT_DIR:"
cat SHASUMS256-mac-selfhosted.txt >&2
