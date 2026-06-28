import { describe, expect, it } from 'vitest';

// CommonJS config plugin (no types); we only exercise the pure string transform.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applyReleaseSigning } = require('../../plugins/withReleaseSigning');

// Mirrors the relevant slice of the Expo/RN-generated android/app/build.gradle.
// Both buildTypes carry the identical `signingConfig signingConfigs.debug`
// line, which is exactly the ambiguity the transform must resolve correctly.
const FIXTURE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
            shrinkResources enableShrinkResources.toBoolean()
            minifyEnabled enableMinifyInReleaseBuilds
        }
    }
}
`;

describe('withReleaseSigning transform', () => {
  const out = applyReleaseSigning(FIXTURE);

  it('adds a release signingConfig gated on the upload-keystore env var', () => {
    expect(out).toContain('storeFile file(System.getenv("COPYPARTY_UPLOAD_STORE_FILE"))');
    expect(out).toContain('if (System.getenv("COPYPARTY_UPLOAD_STORE_FILE")?.trim())');
  });

  it('switches only the release buildType to the conditional selector', () => {
    expect(out).toContain(
      'signingConfig (System.getenv("COPYPARTY_UPLOAD_STORE_FILE")?.trim() ' +
        '? signingConfigs.release : signingConfigs.debug)',
    );
    // The debug buildType must keep signing with the debug config untouched.
    // Search for the release buildType *after* `buildTypes {` so we don't match
    // the injected `release { … }` block inside `signingConfigs`.
    const buildTypesIdx = out.indexOf('buildTypes {');
    const releaseBuildTypeIdx = out.indexOf('release {', buildTypesIdx);
    const debugBuildType = out.slice(buildTypesIdx, releaseBuildTypeIdx);
    expect(debugBuildType).toContain('signingConfig signingConfigs.debug');
  });

  it('is idempotent', () => {
    expect(applyReleaseSigning(out)).toBe(out);
  });

  it('leaves unrelated content unchanged when no signing blocks exist', () => {
    const noop = 'android {\n  namespace "x"\n}\n';
    expect(applyReleaseSigning(noop)).toBe(noop);
  });
});
