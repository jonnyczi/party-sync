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

# Release artifacts ship ARM only. The default RN build compiles native code for
# all four ABIs (arm64-v8a, armeabi-v7a, x86, x86_64); x86/x86_64 are emulator /
# rare-Chromebook only, and building them 4x (Reanimated/Worklets/Hermes/RN core)
# inflates both build time and the intermediate .cxx footprint. Restricting to the
# two ARM ABIs covers all real phones/tablets, ~halves the native build, and
# shrinks the APK. Interactive `expo run:android` dev builds don't use this script,
# so the x86_64 emulator still gets all ABIs. Override with ABIS=… .
ABIS="${ABIS:-armeabi-v7a,arm64-v8a}"

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

# Pin the ARM-only ABI set in the generated gradle.properties (belt-and-suspenders
# alongside the -P flag below — guarantees subprojects honor it regardless of how
# the RN gradle plugin resolves the property). See the ABIS rationale below.
GRADLE_PROPS="android/gradle.properties"
if [ -f "$GRADLE_PROPS" ]; then
  if grep -q '^reactNativeArchitectures=' "$GRADLE_PROPS"; then
    sed -i "s/^reactNativeArchitectures=.*/reactNativeArchitectures=$ABIS/" "$GRADLE_PROPS"
  else
    echo "reactNativeArchitectures=$ABIS" >> "$GRADLE_PROPS"
  fi
  echo "==> pinned reactNativeArchitectures=$ABIS in gradle.properties"
fi

# ccache for the NDK C++ compiles (the dominant cost). CCACHE_DIR lives under the
# gradle home so it rides along in the gradle cache; scripts/ccache.init.gradle
# wires the compiler launchers into every android subproject's CMake build.
export CCACHE_DIR="$HOME/.gradle/ccache"
export CCACHE_MAXSIZE="${CCACHE_MAXSIZE:-2G}"
export CCACHE_COMPRESS=1
mkdir -p "$CCACHE_DIR"
if command -v ccache >/dev/null 2>&1; then
  ccache -z >/dev/null 2>&1 || true   # zero the run's stats so the summary below is per-build
  echo "==> ccache configured (dir=$CCACHE_DIR, max=$CCACHE_MAXSIZE)"
fi

# --build-cache reuses cacheable task outputs (Kotlin/Java compile, and the
# native externalNativeBuild tasks where AGP/the RN libs mark them cacheable)
# from GRADLE_USER_HOME/caches/build-cache-1 — which lives under ~/.gradle and is
# therefore persisted by the gradle cache (CI) / engine cache (local). This is
# what skips recompilation across runs when the inputs are unchanged.
echo "==> gradle $GRADLE_TASK (ABIs=$ABIS, --build-cache, ccache)"
./android/gradlew -p android "$GRADLE_TASK" --build-cache \
  -PreactNativeArchitectures="$ABIS" \
  --init-script "$PWD/scripts/ccache.init.gradle"

# ccache hit/miss summary — watch this in CI logs to confirm the compile cache
# is working (cold run: all misses; warm run: mostly hits).
command -v ccache >/dev/null 2>&1 && { echo "==> ccache stats:"; ccache -s || true; }

# Surface the artifact path on the final line for easy capture by callers.
shopt -s nullglob
artifacts=( $OUT_GLOB )
if [ ${#artifacts[@]} -eq 0 ]; then
  echo "error: no artifact matched $OUT_GLOB" >&2
  exit 1
fi
echo "==> built: ${artifacts[0]}"
