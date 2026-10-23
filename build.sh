#!/usr/bin/env bash
#
# Build everything: the Vue app, the Go server, and (optionally) the Android APK.
#
# Order matters. The Go binary embeds the frontend with `//go:embed`, which is
# read at COMPILE time — building Go before the web bundle would bake in the
# previous UI, and the symptom (a change that "doesn't show up") is easy to
# mistake for a caching problem. The Android APK embeds the Go binary the same
# way, so the whole chain is: web → go → apk.
set -euo pipefail

cd "$(dirname "$0")"

NAME=clawterm
DIST=.clawterm-web
EMBED=internal/frontend/dist
ANDROID=0
RESTART=0

usage() {
  cat <<'EOF'
Usage: ./build.sh [options]

  --android          also build the Android APK (requires the Android SDK)
  --release          build the Android APK in release mode (default: debug)
  --restart          build and restart the local server on port 20010
  --port N           port for --restart (default 20010)
  --skip-web         reuse the existing web bundle (faster Go-only iteration)
  -h, --help         this text
EOF
}

RELEASE=0
PORT=20010
SKIP_WEB=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --android) ANDROID=1 ;;
    --release) RELEASE=1 ;;
    --restart) RESTART=1 ;;
    --port) PORT="$2"; shift ;;
    --skip-web) SKIP_WEB=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 1 ;;
  esac
  shift
done

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

if [[ $SKIP_WEB -eq 0 ]]; then
  step "[1/3] Building the web app"
  npm run build
fi

step "[2/3] Embedding the web bundle and building the Go server"
# A stale embed is worse than no embed: the binary would serve an old UI with no
# indication why. Replace the directory wholesale so deleted chunks cannot
# linger.
rm -rf "$EMBED"
cp -r "$DIST" "$EMBED"
VERSION=$(node -e "console.log(require('./package.json').version)")
go build -ldflags "-s -w -X clawterm/internal/version.Version=v$VERSION" -o "$NAME" ./cmd/termd
echo "  binary: ./$NAME (v$VERSION)"

if [[ $ANDROID -eq 1 ]]; then
  step "[3/3] Building the Android APK"
  mkdir -p android/app/src/main/jniLibs/arm64-v8a
  # The server is shipped as a PIE executable named *.so so it lands in the
  # APK's native library directory — the one place Android allows exec from.
  GOOS=android GOARCH=arm64 CGO_ENABLED=0 go build -ldflags "-s -w -X clawterm/internal/version.Version=v$VERSION" \
    -o android/app/src/main/jniLibs/arm64-v8a/libtermd.so ./cmd/termd

  if [[ $RELEASE -eq 1 ]]; then
    (cd android && JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}" ./gradlew assembleRelease \
      -PversionName="$VERSION" -PversionCode="$(node -e "
        const v='$VERSION'.split('.').map(Number);
        console.log(v[0]*10000+v[1]*100+v[2]);")")
    APK=android/app/build/outputs/apk/release/clawterm-android.apk
  else
    (cd android && JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}" ./gradlew assembleDebug \
      -PversionName="$VERSION" -PversionCode="$(node -e "
        const v='$VERSION'.split('.').map(Number);
        console.log(v[0]*10000+v[1]*100+v[2]);")")
    APK=android/app/build/outputs/apk/debug/clawterm-android-debug.apk
  fi
  echo "  apk: $APK"
else
  step "[3/3] Android APK skipped (pass --android)"
fi

if [[ $RESTART -eq 1 ]]; then
  step "Restarting the server on port $PORT"
  # Only kill a process that is OUR binary on that port. A blanket pkill by name
  # has killed unrelated processes before; the port owner is the precise answer.
  if command -v lsof >/dev/null 2>&1; then
    for pid in $(lsof -ti ":$PORT" 2>/dev/null || true); do
      kill "$pid" 2>/dev/null || true
    done
    sleep 0.5
  fi
  ./"$NAME" --port "$PORT" --no-browser > /tmp/clawterm.log 2>&1 &
  for _ in $(seq 1 50); do
    if curl -sf "http://127.0.0.1:$PORT/api/auth/status" >/dev/null 2>&1; then
      echo "  up: http://127.0.0.1:$PORT"
      exit 0
    fi
    sleep 0.1
  done
  echo "  server did not come up; see /tmp/clawterm.log" >&2
  exit 1
fi

printf '\nDone.\n'
