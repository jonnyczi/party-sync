/**
 * Dagger module for reproducible party-sync Android release builds.
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
 * Toolchain caching (for ephemeral CI runners): `nix-store` realizes the ~5.6 GB
 * toolchain and returns it as a file:// nix binary cache; CI persists that (e.g.
 * actions/cache keyed on flake.lock) and feeds it back via `--nix-cache=<dir>`,
 * which the build uses as a local substituter instead of re-downloading from
 * cache.nixos.org:
 *
 *   dagger call nix-store --nix-cache=./nixcache export --path ./nixcache   # warm/refresh
 *   dagger call build-apk --nix-cache=./nixcache export --path ./out/app.apk
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

// Where the restored file:// nix binary cache is mounted inside the container.
// A side path, NOT /nix — mounting over /nix would shadow the base image's own
// nix binaries and break the first (cache-miss) run.
const NIX_CACHE_DIR = "/nix-cache";

// The flake installable whose closure is the toolchain we cache.
const DEVSHELL = ".#devShells.x86_64-linux.default";

const APK_PATH = "/src/android/app/build/outputs/apk/release/app-release.apk";
const AAB_PATH = "/src/android/app/build/outputs/bundle/release/app-release.aab";

// The gradle home (~/.gradle) is thousands of small files — pathologically slow
// to export/import per-file through Dagger — so we shuttle it as one tarball.
const GRADLE_TAR = "/gradle-cache.tar";

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
  "nixcache",
  "gradlecache",
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
   * debug-signed (the config plugin falls back automatically). Pass `nixCache`
   * (a restored file:// nix cache) to skip re-downloading the toolchain.
   */
  @func()
  async buildApk(
    @argument({ defaultPath: "/", ignore: SOURCE_IGNORE }) source: Directory,
    nixCache?: Directory,
    gradleCache?: File,
    keystore?: Secret,
    keystorePassword?: Secret,
    keyAlias?: Secret,
    keyPassword?: Secret,
  ): Promise<File> {
    return this.nixBuild(
      source,
      "apk",
      nixCache,
      gradleCache,
      keystore,
      keystorePassword,
      keyAlias,
      keyPassword,
    ).file(APK_PATH);
  }

  /** Build a release AAB for Google Play. Signing/caching identical to {@link buildApk}. */
  @func()
  async buildAab(
    @argument({ defaultPath: "/", ignore: SOURCE_IGNORE }) source: Directory,
    nixCache?: Directory,
    gradleCache?: File,
    keystore?: Secret,
    keystorePassword?: Secret,
    keyAlias?: Secret,
    keyPassword?: Secret,
  ): Promise<File> {
    return this.nixBuild(
      source,
      "aab",
      nixCache,
      gradleCache,
      keystore,
      keystorePassword,
      keyAlias,
      keyPassword,
    ).file(AAB_PATH);
  }

  /**
   * Realize the toolchain and return it as a refreshed file:// nix binary cache
   * — *without* building the app (it's just the toolchain). CI persists this
   * (e.g. actions/cache keyed on flake.lock) and feeds it back via `--nix-cache`.
   * `nixCache` is the previously-restored cache (empty on a miss) used as a
   * substituter so a warm refresh is cheap.
   */
  @func()
  nixStore(
    @argument({ defaultPath: "/", ignore: SOURCE_IGNORE }) source: Directory,
    nixCache?: Directory,
  ): Directory {
    return this.nixContainer(source, nixCache)
      // Realize the devShell closure (pulls from the restored cache or
      // cache.nixos.org), then write it to the file:// cache for next time.
      .withExec(["nix", "develop", "--command", "true"])
      .withExec([
        "sh",
        "-c",
        `nix copy --to 'file://${NIX_CACHE_DIR}?compression=none' ${DEVSHELL}`,
      ])
      .directory(NIX_CACHE_DIR);
  }

  /**
   * Build the app and return the populated gradle home as a single tarball
   * (`/root/.gradle`: wrapper dist + AndroidX/RN deps + build-cache + ccache).
   * CI persists this (actions/cache keyed on package-lock.json) and feeds it
   * back via `--gradle-cache`. Pass the *same* args as the build (incl. signing)
   * so Dagger dedups the work — this just tars a different output from the
   * already-built container.
   */
  @func()
  gradleStore(
    @argument({ defaultPath: "/", ignore: SOURCE_IGNORE }) source: Directory,
    nixCache?: Directory,
    gradleCache?: File,
    keystore?: Secret,
    keystorePassword?: Secret,
    keyAlias?: Secret,
    keyPassword?: Secret,
  ): File {
    return this.nixBuild(
      source,
      "apk",
      nixCache,
      gradleCache,
      keystore,
      keystorePassword,
      keyAlias,
      keyPassword,
    )
      // Tar the populated gradle home into one file (excluding volatile daemon /
      // tmp dirs) — fast to export vs thousands of small files.
      .withExec([
        "sh",
        "-c",
        `tar -C /root/.gradle --exclude=./daemon --exclude=./.tmp -cf ${GRADLE_TAR} . || true`,
      ])
      .file(GRADLE_TAR);
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

  /**
   * Base nixos/nix container with flakes enabled and, when `nixCache` is given,
   * the restored file:// cache mounted at a side path and registered as a local
   * substituter so `nix develop` pulls the toolchain from it.
   */
  private nixContainer(source: Directory, nixCache?: Directory): Container {
    const confLines = [
      "experimental-features = nix-command flakes",
      "require-sigs = false", // our file:// cache nars are unsigned
    ];

    let c = dag
      .container()
      .from(NIX_IMAGE)
      .withMountedCache("/root/.npm", dag.cacheVolume("copyparty-npm"))
      .withDirectory("/src", source)
      .withWorkdir("/src");

    if (nixCache) {
      // Side path (NOT /nix). withDirectory (copy in) — not withMountedDirectory
      // — so writes from `nix copy` are captured and retrievable via .directory().
      c = c.withDirectory(NIX_CACHE_DIR, nixCache);
      confLines.push(`extra-substituters = file://${NIX_CACHE_DIR}`);
      confLines.push(`extra-trusted-substituters = file://${NIX_CACHE_DIR}`);
    }

    const writeConf =
      "mkdir -p /etc/nix && " +
      confLines.map((l) => `echo '${l}' >> /etc/nix/nix.conf`).join(" && ");
    return c.withExec(["sh", "-c", writeConf]);
  }

  private nixBuild(
    source: Directory,
    artifact: "apk" | "aab",
    nixCache?: Directory,
    gradleCache?: File,
    keystore?: Secret,
    keystorePassword?: Secret,
    keyAlias?: Secret,
    keyPassword?: Secret,
  ): Container {
    let c = this.nixContainer(source, nixCache);

    // Gradle home (wrapper dist + AndroidX/RN deps + build-cache + ccache).
    // CI passes it as a single tarball (fast transfer); untar into /root/.gradle.
    // An empty/missing tar (cache miss) is a harmless no-op. Local dev (no
    // gradleCache) uses the engine cache volume.
    if (gradleCache) {
      c = c
        .withMountedFile(GRADLE_TAR, gradleCache)
        .withExec(["sh", "-c", `mkdir -p /root/.gradle && tar -C /root/.gradle -xf ${GRADLE_TAR} || true`]);
    } else {
      c = c.withMountedCache("/root/.gradle", dag.cacheVolume("copyparty-gradle"));
    }

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
    return c.withExec(["nix", "develop", "--command", "bash", "scripts/ci-android-build.sh", artifact]);
  }
}
