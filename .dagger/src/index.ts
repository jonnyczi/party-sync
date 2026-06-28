/**
 * Dagger module for reproducible copyparty-client Android release builds.
 *
 * The release build runs inside a `nixos/nix` container, so flake.nix stays the
 * single source of truth for the toolchain (JDK, Android SDK/NDK, gradle, node).
 * The only host prerequisite is a container runtime — no Nix, no Android SDK on
 * the machine. The same pipeline runs locally and in any CI:
 *
 *   dagger call build-apk export --path ./out          # debug-signed
 *   dagger call build-apk \                             # upload-signed
 *     --keystore=file:upload.keystore \
 *     --keystore-password=env:STORE_PW \
 *     --key-alias=env:KEY_ALIAS \
 *     --key-password=env:KEY_PW \
 *     export --path ./out
 *
 * Lint/test run in a plain Node container (no Nix toolchain needed) for speed.
 *
 * NOTE: run `dagger develop` once (after upgrading the Dagger CLI) to generate
 * the `.dagger/sdk` client + package.json/tsconfig before the first `dagger call`.
 */
import {
  dag,
  argument,
  object,
  func,
  Container,
  Directory,
  File,
  Secret,
} from "@dagger.io/dagger";

// nixos/nix base — provides nix + flakes. Pin to a digest after the first
// successful run for full reproducibility (tag is mutable).
const NIX_IMAGE = "nixos/nix:latest";
const NODE_IMAGE = "node:22-bookworm";

// Source files Dagger should NOT upload into the build context: heavy or
// generated, and regenerated inside the container (android/ via prebuild,
// node_modules via npm ci).
const SOURCE_IGNORE = [
  "node_modules",
  "android",
  "ios",
  ".expo",
  "out",
  ".git",
  ".dagger/sdk",
  "tmp",
];

@object()
export class Copyparty {
  /** Lint the codebase (`expo lint`). */
  @func()
  async lint(
    @argument({ defaultPath: "/", ignore: SOURCE_IGNORE }) source: Directory,
  ): Promise<string> {
    return this.nodeBase(source).withExec(["npm", "run", "lint"]).stdout();
  }

  /** Run the vitest unit suite. */
  @func()
  async test(
    @argument({ defaultPath: "/", ignore: SOURCE_IGNORE }) source: Directory,
  ): Promise<string> {
    return this.nodeBase(source).withExec(["npm", "test"]).stdout();
  }

  /**
   * Build a universal release APK (for GitHub Releases / sideload). Signed with
   * the upload keystore when `keystore` (+ passwords) are provided, otherwise
   * debug-signed (the config plugin falls back automatically).
   */
  @func()
  async buildApk(
    @argument({ defaultPath: "/", ignore: SOURCE_IGNORE }) source: Directory,
    keystore?: Secret,
    keystorePassword?: Secret,
    keyAlias?: Secret,
    keyPassword?: Secret,
  ): Promise<File> {
    return this.nixBuild(source, "apk", keystore, keystorePassword, keyAlias, keyPassword).file(
      "/src/android/app/build/outputs/apk/release/app-release.apk",
    );
  }

  /** Build a release AAB for Google Play. Signing identical to {@link buildApk}. */
  @func()
  async buildAab(
    @argument({ defaultPath: "/", ignore: SOURCE_IGNORE }) source: Directory,
    keystore?: Secret,
    keystorePassword?: Secret,
    keyAlias?: Secret,
    keyPassword?: Secret,
  ): Promise<File> {
    return this.nixBuild(source, "aab", keystore, keystorePassword, keyAlias, keyPassword).file(
      "/src/android/app/build/outputs/bundle/release/app-release.aab",
    );
  }

  // --- helpers ---------------------------------------------------------------

  private nodeBase(source: Directory): Container {
    return dag
      .container()
      .from(NODE_IMAGE)
      .withMountedCache("/root/.npm", dag.cacheVolume("copyparty-npm"))
      .withDirectory("/src", source)
      .withWorkdir("/src")
      .withExec(["npm", "ci"]);
  }

  private nixBuild(
    source: Directory,
    artifact: "apk" | "aab",
    keystore?: Secret,
    keystorePassword?: Secret,
    keyAlias?: Secret,
    keyPassword?: Secret,
  ): Container {
    let c = dag
      .container()
      .from(NIX_IMAGE)
      .withExec([
        "sh",
        "-c",
        "mkdir -p /etc/nix && echo 'experimental-features = nix-command flakes' >> /etc/nix/nix.conf",
      ])
      // Gradle + npm caches survive across runs; the Nix store itself is cached
      // by Dagger's layer cache keyed on flake.lock (don't mount over /nix — it
      // would shadow the base image's nix binaries).
      .withMountedCache("/root/.gradle", dag.cacheVolume("copyparty-gradle"))
      .withMountedCache("/root/.npm", dag.cacheVolume("copyparty-npm"))
      .withDirectory("/src", source)
      .withWorkdir("/src");

    if (keystore) {
      c = c
        .withMountedSecret("/keystore/upload.keystore", keystore)
        .withEnvVariable("COPYPARTY_UPLOAD_STORE_FILE", "/keystore/upload.keystore");
      if (keystorePassword)
        c = c.withSecretVariable("COPYPARTY_UPLOAD_STORE_PASSWORD", keystorePassword);
      if (keyAlias) c = c.withSecretVariable("COPYPARTY_UPLOAD_KEY_ALIAS", keyAlias);
      if (keyPassword) c = c.withSecretVariable("COPYPARTY_UPLOAD_KEY_PASSWORD", keyPassword);
    }

    // All build logic lives in scripts/ci-android-build.sh (npm ci -> prebuild
    // -> wrapper harden -> gradle), shared with local builds.
    return c.withExec([
      "nix",
      "develop",
      "--command",
      "bash",
      "scripts/ci-android-build.sh",
      artifact,
    ]);
  }
}
