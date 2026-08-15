import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState } from 'react-native';

/**
 * Safety net for a hand-off that never lands. An intent refused silently (some
 * OEM builds) never backgrounds the app, and without this the button would stay
 * dead until the screen is left.
 */
const HANDOFF_TIMEOUT_MS = 8_000;

export interface AsyncActionOptions {
  /**
   * Set for an action that hands off to another Activity — a system settings
   * screen, a Custom Tab, the SAF picker.
   *
   * Those resolve the instant `startActivity()` returns, which is *before*
   * Android has drawn the other window, so resolution is the wrong signal to
   * clear on: the button would un-grey while the user is still looking at ours.
   * The app leaving the foreground is what says the hand-off actually landed.
   */
  handsOff?: boolean;
  /** Raise an Alert with this title when the action throws. Omit for warn-only. */
  errorTitle?: string;
  /** Second line of that Alert — say how to get there by hand. */
  errorBody?: string;
}

/**
 * Pending state for a one-shot action behind a button or switch.
 *
 * Exists because six call sites across four screens hand off to a system
 * Activity whose cold start takes seconds, and each was hand-rolling nothing at
 * all: no busy flag, no disabled state, and repeat taps queueing extra
 * `startActivity` calls. The state machine — not the markup — is the part worth
 * sharing, which is why this is a hook and not a button component (two of the
 * call sites are `Switch`es, and the four buttons have four different styles).
 *
 * `run` returns void and forwards its arguments to `fn`, so it drops straight
 * into an `onPress` (which ignores them) or an `onValueChange` (which needs the
 * new value — and needs it synchronously, so routing it through state would
 * hand `fn` the previous render's value).
 */
export function useAsyncAction<A extends unknown[]>(
  fn: (...args: A) => Promise<unknown> | unknown,
  opts?: AsyncActionOptions,
): { run: (...args: A) => void; pending: boolean } {
  const { handsOff = false, errorTitle, errorBody } = opts ?? {};

  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);

  // Kept in a ref so `run` stays stable while always invoking the current
  // closure — rows are re-created on every probe, so `fn` changes identity
  // constantly and a dependency on it would defeat the re-entrancy guard.
  const latest = useRef(fn);
  latest.current = fn;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const settle = useCallback(() => {
    busy.current = false;
    if (mounted.current) setPending(false);
  }, []);

  const run = useCallback(
    (...args: A) => {
      // A ref, not the state: two taps in the same frame both see the old state
      // but only the first sees a false ref.
      if (busy.current) return;
      busy.current = true;
      setPending(true);

      void (async () => {
        try {
          await latest.current(...args);
          if (!handsOff) settle();
        } catch (e) {
          console.warn('[copyparty] action failed', e);
          if (errorTitle) {
            Alert.alert(errorTitle, errorBody ?? (e instanceof Error ? e.message : String(e)));
          }
          settle();
        }
      })();
    },
    [handsOff, errorTitle, errorBody, settle],
  );

  // Only subscribed while a hand-off is in flight — a permanent listener per
  // row would cost more than it buys.
  useEffect(() => {
    if (!pending || !handsOff) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') settle();
    });
    const timer = setTimeout(settle, HANDOFF_TIMEOUT_MS);
    return () => {
      sub.remove();
      clearTimeout(timer);
    };
  }, [pending, handsOff, settle]);

  return { run, pending };
}
