#!/usr/bin/env bash
#
# Build the signed CloudCLI TWA APK from the sources tracked in this directory.
#
# Steps:
#   1. install the pinned bubblewrap toolchain (package-lock.json) if missing
#   2. regenerate the Android project from twa-manifest.json
#      (generate-twa-project.js; the Gradle project itself is not tracked)
#   3. build an unsigned, aligned APK with `bubblewrap build --skipSigning`
#   4. sign it with apksigner, passing the keystore passwords through the
#      environment (`--ks-pass env:...`), not on the command line
#   5. refuse the result unless its signing certificate matches the SHA-256
#      fingerprint that https://<host>/.well-known/assetlinks.json publishes
#      for the package. A mismatch means the app would open with an address
#      bar, so it is treated as a build failure, not a warning.
#
# Why step 3 skips bubblewrap's own signing: bubblewrap hands both passwords to
# apksigner as `pass:<secret>` arguments, which anything running `ps` on this
# machine can read while the build runs.
#
# Output: dist/cloudcli-<appVersionName>.apk (git-ignored).
#
# Environment overrides:
#   TWA_CREDENTIALS   credentials file, default ~/.android-keystores/cloudcli-twa.credentials
#                     (key=value lines: keystore, alias, storepass, keypass; never tracked)
#   SKIP_ASSETLINKS_CHECK=1  build without network access to the live host
#                     (the fingerprint check is then skipped and says so)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

TWA_CREDENTIALS="${TWA_CREDENTIALS:-$HOME/.android-keystores/cloudcli-twa.credentials}"
BUBBLEWRAP_CONFIG="$HOME/.bubblewrap/config.json"

log() { printf '[build.sh] %s\n' "$*" >&2; }
die() { printf '[build.sh] ERROR: %s\n' "$*" >&2; exit 1; }

manifest_field() {
  node -e 'const m = require(process.argv[1]); const v = m[process.argv[2]]; if (v === undefined) process.exit(2); console.log(v);' \
    "$HERE/twa-manifest.json" "$1"
}

[ -f "$TWA_CREDENTIALS" ] || die "credentials file not found: $TWA_CREDENTIALS"
[ -f "$BUBBLEWRAP_CONFIG" ] || die "bubblewrap is not configured ($BUBBLEWRAP_CONFIG missing); it needs its own JDK 17 and Android SDK"

KS_PATH="" KS_ALIAS="" KS_STOREPASS="" KS_KEYPASS=""
while IFS='=' read -r key value; do
  case "$key" in
    keystore)  KS_PATH="$value" ;;
    alias)     KS_ALIAS="$value" ;;
    storepass) KS_STOREPASS="$value" ;;
    keypass)   KS_KEYPASS="$value" ;;
  esac
done < "$TWA_CREDENTIALS"
[ -n "$KS_PATH" ] && [ -n "$KS_ALIAS" ] && [ -n "$KS_STOREPASS" ] && [ -n "$KS_KEYPASS" ] \
  || die "credentials file must define keystore, alias, storepass and keypass"
[ -f "$KS_PATH" ] || die "keystore not found: $KS_PATH"

PACKAGE_ID="$(manifest_field packageId)"
HOST="$(manifest_field host)"
VERSION_NAME="$(manifest_field appVersionName)"
VERSION_CODE="$(manifest_field appVersionCode)"
log "package $PACKAGE_ID, host $HOST, version $VERSION_NAME ($VERSION_CODE)"

ANDROID_SDK="$(node -e 'console.log(require(process.argv[1]).androidSdkPath)' "$BUBBLEWRAP_CONFIG")"
JDK_HOME="$(node -e 'console.log(require(process.argv[1]).jdkPath)' "$BUBBLEWRAP_CONFIG")"
APKSIGNER_JAR="$(ls -1 "$ANDROID_SDK"/build-tools/*/lib/apksigner.jar 2>/dev/null | sort -V | tail -1)"
[ -n "$APKSIGNER_JAR" ] || die "apksigner.jar not found under $ANDROID_SDK/build-tools"
JAVA="$JDK_HOME/bin/java"
[ -x "$JAVA" ] || die "java not found at $JAVA"
apksigner() { "$JAVA" -jar "$APKSIGNER_JAR" "$@"; }

if [ ! -d node_modules/@bubblewrap/cli ]; then
  log "installing the pinned bubblewrap toolchain"
  npm ci --no-audit --no-fund
fi

log "regenerating the Android project from twa-manifest.json"
node generate-twa-project.js

log "building the unsigned APK"
rm -f app-release-unsigned-aligned.apk
npx --no-install bubblewrap build --skipPwaValidation --skipSigning
[ -f app-release-unsigned-aligned.apk ] || die "bubblewrap did not produce app-release-unsigned-aligned.apk"

mkdir -p dist
OUT="dist/cloudcli-$VERSION_NAME.apk"
# Signed under a temporary name and moved into place only after every check
# passes, so a rejected build never overwrites a good APK in dist/.
SIGNED="dist/.cloudcli-$VERSION_NAME.apk.partial"
trap 'rm -f "$SIGNED" "$SIGNED.idsig"' EXIT
log "signing"
BUILD_KS_PASS="$KS_STOREPASS" BUILD_KEY_PASS="$KS_KEYPASS" apksigner sign \
  --ks "$KS_PATH" \
  --ks-key-alias "$KS_ALIAS" \
  --ks-pass env:BUILD_KS_PASS \
  --key-pass env:BUILD_KEY_PASS \
  --out "$SIGNED" \
  app-release-unsigned-aligned.apk

APK_FINGERPRINT="$(apksigner verify --print-certs "$SIGNED" \
  | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | tr 'a-f' 'A-F')"
[ -n "$APK_FINGERPRINT" ] || die "apksigner verify printed no signer digest"
log "APK signer SHA-256: $APK_FINGERPRINT"

if [ "${SKIP_ASSETLINKS_CHECK:-0}" = "1" ]; then
  log "SKIP_ASSETLINKS_CHECK=1: the fingerprint was NOT compared with the live assetlinks.json"
else
  PUBLISHED="$(curl -fsS "https://$HOST/.well-known/assetlinks.json" | node -e '
    let raw = ""; process.stdin.on("data", (c) => raw += c).on("end", () => {
      const pkg = process.argv[1];
      const prints = JSON.parse(raw)
        .filter((s) => s.target && s.target.package_name === pkg)
        .flatMap((s) => s.target.sha256_fingerprints || s.target.sha256_cert_fingerprints || []);
      console.log(prints.map((p) => p.replace(/:/g, "").toUpperCase()).join("\n"));
    });' "$PACKAGE_ID")"
  echo "$PUBLISHED" | grep -qx "$APK_FINGERPRINT" \
    || die "signer $APK_FINGERPRINT is not published for $PACKAGE_ID at https://$HOST/.well-known/assetlinks.json"
  log "fingerprint matches the live assetlinks.json for $PACKAGE_ID"
fi

mv "$SIGNED" "$OUT"
log "done: $HERE/$OUT"
sha256sum "$OUT"
