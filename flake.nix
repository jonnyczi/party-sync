{
  description = "copyparty-client Expo + Android dev environment";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-25.11";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";

      pkgs = import nixpkgs {
        inherit system;
        config = {
          allowUnfree = true;
          android_sdk.accept_license = true;
        };
      };

      androidComposition = pkgs.androidenv.composeAndroidPackages {
        # Platform 36 = react-native 0.81 default (compileSdk).
        # Platform 35 = expo-module-gradle-plugin's fallback default for native modules
        # (e.g. modules/copyparty-sha512) when no version catalog overrides it.
        platformVersions = [ "36" "35" ];
        buildToolsVersions = [ "36.0.0" "35.0.0" ];
        ndkVersions = [ "27.1.12297006" ];
        cmakeVersions = [ "3.22.1" ];
        includeEmulator = false;
        includeSystemImages = false;
        includeSources = false;
        includeNDK = true;
      };

      androidSdk = androidComposition.androidsdk;
    in {
      devShells.${system}.default = pkgs.mkShell {
        buildInputs = [
          pkgs.jdk17
          pkgs.gradle
          androidSdk
          # Node toolchain (Expo CLI / prebuild / Metro bundle) pinned in the
          # flake so the devShell is self-sufficient. Interactive dev previously
          # relied on the host's node being on PATH; CI release builds run inside
          # a bare `nixos/nix` container (via Dagger) where nothing but what the
          # devShell declares exists — so node, curl (gradle-wrapper priming) and
          # git (expo prebuild shells out to it) must be declared here.
          pkgs.nodejs_22
          pkgs.curl
          pkgs.git
          # Compiler cache for the RN/Reanimated NDK C++ builds — wired into the
          # CMake compiles via scripts/ccache.init.gradle so unchanged translation
          # units aren't recompiled across CI runs (the dominant build cost).
          pkgs.ccache
          # For downscaling emulator screencaps before feeding them to Claude —
          # vision tokens are driven by pixel count, not file size.
          pkgs.imagemagick
        ];

        shellHook = ''
          export ANDROID_SDK_ROOT="${androidSdk}/libexec/android-sdk"
          export ANDROID_HOME="$ANDROID_SDK_ROOT"
          export ANDROID_NDK_ROOT="$ANDROID_SDK_ROOT/ndk/27.1.12297006"
          export JAVA_HOME="${pkgs.jdk17.home}"
          # Use the nix-patched aapt2 instead of the prebuilt one AGP downloads from Maven.
          export GRADLE_OPTS="-Dorg.gradle.project.android.aapt2FromMavenOverride=$ANDROID_SDK_ROOT/build-tools/36.0.0/aapt2"

          echo "Expo Android dev shell loaded"
          echo "  JAVA_HOME:   $JAVA_HOME"
          echo "  ANDROID_SDK: $ANDROID_SDK_ROOT"
          echo "  ANDROID_NDK: $ANDROID_NDK_ROOT"

          # --- gradle wrapper hardening ---------------------------------------------
          # The wrapper that `expo prebuild` writes ships with networkTimeout=10000ms,
          # which is too short for the ~140 MB Gradle distribution download (we hit
          # repeated SocketTimeouts and a github 504). Bump it whenever we see the
          # default. android/ is gitignored so this won't dirty the repo.
          wrapperProps="$PWD/android/gradle/wrapper/gradle-wrapper.properties"
          if [ -f "$wrapperProps" ] && grep -q '^networkTimeout=10000$' "$wrapperProps"; then
            sed -i 's/^networkTimeout=10000$/networkTimeout=600000/' "$wrapperProps"
            echo "  patched gradle-wrapper.properties: networkTimeout 10000 -> 600000"
          fi

          # Pre-stage the Gradle distribution zip in the wrapper cache. The wrapper
          # will skip the download when the .ok marker is present. We do this even
          # if the cache dir doesn't exist yet — invoke `gradlew --version` once to
          # let Gradle create the (URL-hashed) cache directory, then download into
          # whatever path it picked.
          if [ -f "$wrapperProps" ]; then
            distUrl="$(sed -n 's/^distributionUrl=//p' "$wrapperProps" | sed 's|\\:|:|g')"
            distFile="$(basename "$distUrl")"          # e.g. gradle-8.14.3-bin.zip
            distVerType="''${distFile%.zip}"           # e.g. gradle-8.14.3-bin
            distRoot="$HOME/.gradle/wrapper/dists/$distVerType"
            cacheDir="$(ls -d "$distRoot"/*/ 2>/dev/null | head -n1)"

            if [ -z "$cacheDir" ]; then
              # No cache dir yet — let gradlew create it. Suppress its output;
              # we only care about the side-effect of the directory being created.
              (cd "$PWD/android" && ./gradlew --version >/dev/null 2>&1 || true)
              cacheDir="$(ls -d "$distRoot"/*/ 2>/dev/null | head -n1)"
            fi

            if [ -n "$cacheDir" ]; then
              cacheDir="''${cacheDir%/}"
              if [ -f "$cacheDir/$distFile.ok" ]; then
                echo "  gradle wrapper cache: ready ($distFile)"
              else
                echo "  gradle wrapper cache: priming $distFile..."
                rm -f "$cacheDir/$distFile.lck" "$cacheDir/$distFile.part"
                if curl -L --connect-timeout 30 --max-time 600 --retry 3 \
                       --retry-delay 5 -fsSL -o "$cacheDir/$distFile" "$distUrl"; then
                  touch "$cacheDir/$distFile.ok"
                  echo "  gradle wrapper cache: ready ($distFile)"
                else
                  echo "  gradle wrapper cache: download failed."
                  echo "  retry manually:  curl -L --max-time 600 -o '$cacheDir/$distFile' '$distUrl' && touch '$cacheDir/$distFile.ok'"
                fi
              fi
            fi
          fi
        '';
      };
    };
}
