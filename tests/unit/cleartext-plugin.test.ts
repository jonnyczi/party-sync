import { describe, expect, it } from 'vitest';

// CommonJS config plugin (no types); we only exercise the pure manifest transform.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setUsesCleartextTraffic } = require('../../plugins/withCleartextTraffic');

// Minimal slice of the parsed AndroidManifest.xml shape @expo/config-plugins
// produces: a <manifest> with a single <application android:name=".MainApplication">.
const manifest = () => ({
  manifest: {
    application: [{ $: { 'android:name': '.MainApplication' } }],
  },
});

describe('withCleartextTraffic transform', () => {
  it('sets android:usesCleartextTraffic="true" on the main application', () => {
    const out = setUsesCleartextTraffic(manifest());
    expect(out.manifest.application[0].$['android:usesCleartextTraffic']).toBe('true');
  });

  it('is idempotent', () => {
    const out = setUsesCleartextTraffic(setUsesCleartextTraffic(manifest()));
    expect(out.manifest.application[0].$['android:usesCleartextTraffic']).toBe('true');
  });
});
