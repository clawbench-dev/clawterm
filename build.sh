#!/usr/bin/env bash
#
# Build the app.
#
# This is a CLIENT-ONLY project: there is no server, no binary to run and no port
# to listen on. The Vue app is compiled into the APK's assets and the SSH client
# runs inside the app process, so "building" means producing an APK.
set -euo pipefail
cd "$(dirname "$0")"

ANDROID=0
RELEASE=0
SKIP_WEB=0

usage() {
  cat <<'USAGE'
Usage: ./build.sh [options]

  --android        build the APK (required; there is no other artifact)
  --release        signed release build (default: debug)
  --skip-web       reuse the existing web bundle
  -h, --help       this text

With no arguments the APK is built in debug mode.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --android) ANDROID=1 ;;
    --release) RELEASE=1 ;;
    --skip-web) SKIP_WEB=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 1 ;;
  esac
  shift
done

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

VERSION=$(node -e "console.log(require('./package.json').version)")
VERSION_CODE=$(node -e "const v='$VERSION'.split('.').map(Number);console.log(v[0]*10000+v[1]*100+v[2])")

if [[ $SKIP_WEB -eq 0 ]]; then
  step "[1/2] Building the web app into the APK's assets"
  # `npm run build` cleans .clawterm-web, builds, and copies the result into
  # android/app/src/main/assets/web. A stale bundle there is served from the
  # APK with no way to notice, so the copy is part of the build, not a manual step.
  npm run build
else
  step "[1/2] Web build skipped"
fi

step "[2/2] Building the APK"
GRADLE_TASK=assembleDebug
APK=android/app/build/outputs/apk/debug/clawterm-android-debug.apk
if [[ $RELEASE -eq 1 ]]; then
  GRADLE_TASK=assembleRelease
  APK=android/app/build/outputs/apk/release/clawterm-android.apk
fi

(cd android && JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}" \
  ./gradlew "$GRADLE_TASK" -PversionName="$VERSION" -PversionCode="$VERSION_CODE")

echo "  apk: $APK"
# The APK must not contain a native library: one was how the previous version
# shipped a Go server inside the app. Checked here so a revert is caught at build
# time rather than by a user noticing a port being opened.
if unzip -l "$APK" | grep -qE '^\s+[0-9]+.*\slib/'; then
  echo "ERROR: the APK contains a native library — this build must be client-only" >&2
  unzip -l "$APK" | grep -E '\slib/' >&2
  exit 1
fi
echo "  verified: no native libraries, no bundled server"
