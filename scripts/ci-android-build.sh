#!/usr/bin/env bash
# Canonical Android release build. Single source of build steps, reused by:
#   - local:  nix develop --command ./scripts/ci-android-build.sh apk
#   - CI:     Dagger runs `nix develop --command ./scripts/ci-android-build.sh apk`
#             inside a nixos/nix container.
#
# Assumes it runs INSIDE the Nix devShell (JAVA_HOME / ANDROID_SDK_ROOT /
# GRADLE_OPTS already exported by flake.nix's shellHook). It does NOT handle
# signing material: the release signingConfig (plugins/withReleaseSigning.js)
# reads COPYPARTY_UPLOAD_STORE_* from the environment at Gradle eval time, so
# the caller is responsible for writing the keystore and exporting those vars.
# With them absent the build falls back to debug signing (dev / F-Droid).
set -euo pipefail

ARTIFACT="${1:-apk}" # apk | aab
case "$ARTIFACT" in
  apk) GRADLE_TASK=":app:assembleRelease"; OUT_GLOB="android/app/build/outputs/apk/release/*.apk" ;;
  aab) GRADLE_TASK=":app:bundleRelease";   OUT_GLOB="android/app/build/outputs/bundle/release/*.aab" ;;
  *) echo "usage: ci-android-build.sh [apk|aab]" >&2; exit 2 ;;
esac

if [ -z "${JAVA_HOME:-}" ] || ! command -v node >/dev/null 2>&1; then
  echo "error: not inside the Nix devShell (JAVA_HOME/node missing)." >&2
  echo "run via: nix develop --command $0 $ARTIFACT" >&2
  exit 1
fi

echo "==> npm ci (prod deps only; devDeps aren't needed to build the app)"
npm ci --omit=dev

echo "==> expo prebuild (regenerate android/ from app.json + config plugins)"
npx expo prebuild --clean -p android

# The wrapper that prebuild just wrote ships networkTimeout=10000ms, too short
# for the ~140 MB Gradle distribution download (repeated SocketTimeouts). The
# flake shellHook can't fix this — it runs before android/ exists — so do it
# here, post-prebuild, before invoking the wrapper.
WRAPPER_PROPS="android/gradle/wrapper/gradle-wrapper.properties"
if [ -f "$WRAPPER_PROPS" ] && grep -q '^networkTimeout=10000$' "$WRAPPER_PROPS"; then
  sed -i 's/^networkTimeout=10000$/networkTimeout=600000/' "$WRAPPER_PROPS"
  echo "==> patched gradle-wrapper networkTimeout 10000 -> 600000"
fi

echo "==> gradle $GRADLE_TASK"
./android/gradlew -p android "$GRADLE_TASK"

# Surface the artifact path on the final line for easy capture by callers.
shopt -s nullglob
artifacts=( $OUT_GLOB )
if [ ${#artifacts[@]} -eq 0 ]; then
  echo "error: no artifact matched $OUT_GLOB" >&2
  exit 1
fi
echo "==> built: ${artifacts[0]}"
