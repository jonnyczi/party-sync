import { AppState, Platform } from 'react-native';

import CopypartySync from '../../modules/copyparty-sync';
import type { SqliteDb } from '../db/adapter';
import { getBandwidthMode } from '../db/settings';

import { abortableSleep, createPacer, type Pacer } from './throttle';

/**
 * Device-backed wiring for the bandwidth limiter. Split from `throttle.ts` so
 * the duty-cycle maths stays importable from a Node test environment — this
 * file pulls in react-native and the native module, which vitest cannot parse.
 * Same split as `src/copyparty/hash.native.ts`: triggers import from here and
 * inject the result into the engine.
 */

/**
 * Is the screen on — i.e. is someone plausibly using the phone?
 *
 * Falls back to AppState where the native probe is unavailable (iOS/web, or a
 * binary predating the function — a JS-only reload will not pick up a new
 * native Function, hence the typeof check). That fallback is one-directional:
 * this app being foregrounded proves the screen is on, but not the reverse, so
 * a background sync there simply runs unthrottled rather than guessing.
 */
export function defaultIsScreenOn(): boolean {
  if (Platform.OS === 'android') {
    const probe = CopypartySync?.isScreenInteractive;
    if (typeof probe === 'function') return probe.call(CopypartySync);
  }
  return AppState.currentState === 'active';
}

/** The pacer a real run uses: live setting, real screen state, real clock. */
export function createSettingsPacer(db: SqliteDb): Pacer {
  return createPacer({
    readMode: () => getBandwidthMode(db),
    isScreenOn: defaultIsScreenOn,
    now: Date.now,
    sleep: abortableSleep,
  });
}
