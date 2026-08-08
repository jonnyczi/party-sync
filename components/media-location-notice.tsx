import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, AppState, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import CopypartySync from '@/modules/copyparty-sync';
import {
  getMediaLocationPermission,
  requestMediaLocationPermission,
} from '@/src/media/media-permission';

/**
 * Shown on media jobs when ACCESS_MEDIA_LOCATION isn't granted.
 *
 * Without it Android zero-fills the EXIF GPS block in every geotagged photo we
 * read, so the backup silently differs from the originals and can never dedup
 * against a copy made any other way. That's invisible from inside the app —
 * uploads succeed, sizes match — so it needs a standing notice rather than a
 * one-off toast.
 *
 * Deliberately does not re-prompt on its own: the request happens as part of
 * the normal media-permission flow, and after two denials Android stops showing
 * the dialog entirely, at which point the settings shortcut is the only way
 * back. Renders nothing when granted (or on a platform with no redaction).
 */
export function MediaLocationNotice({ onChange }: { onChange?: () => void } = {}) {
  const scheme = useColorScheme() ?? 'light';
  const [denied, setDenied] = useState(false);

  const refresh = useCallback(async () => {
    setDenied((await getMediaLocationPermission()) === 'denied');
  }, []);

  // The grant can land without any interaction of ours: Android silently
  // auto-grants ACCESS_MEDIA_LOCATION alongside an already-held photos
  // permission the first time a run requests it, and the user may also flip it
  // in system settings. Re-check on focus and on app resume so the notice can't
  // sit there claiming a problem that's already been fixed.
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  const onGrant = useCallback(async () => {
    const result = await requestMediaLocationPermission();
    if (result === 'granted') {
      setDenied(false);
      onChange?.();
      return;
    }
    // Either they declined again or Android suppressed the dialog; both are
    // only recoverable from the system settings page.
    Alert.alert(
      'Photo location access',
      'Android will only hand over a photo’s location data with your permission. ' +
        'Enable it under Permissions in system settings to back up photos exactly as they are.',
      [
        { text: 'Not now', style: 'cancel' },
        {
          text: 'Open settings',
          onPress: () => {
            CopypartySync?.openAppSettings().catch(() => {});
          },
        },
      ],
    );
  }, [onChange]);

  if (!denied) return null;

  const icon = Colors[scheme].icon;
  const tint = Colors[scheme].tint;

  return (
    <View style={[styles.notice, { borderColor: icon }]}>
      <IconSymbol name="exclamationmark.triangle.fill" color={icon} size={16} />
      <View style={styles.body}>
        <ThemedText style={styles.title}>Photos are backed up without location</ThemedText>
        <ThemedText style={styles.text}>
          Android removes the GPS tag from photos this app reads unless you allow it. Backed-up
          photos lose their location, and may upload a second copy instead of being recognised as
          already on your server.
        </ThemedText>
        <Pressable onPress={onGrant} accessibilityRole="button">
          <ThemedText style={[styles.action, { color: tint }]}>
            Allow photo location
          </ThemedText>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  notice: {
    flexDirection: 'row',
    gap: 10,
    padding: 12,
    marginBottom: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
  },
  body: { flex: 1, minWidth: 0, gap: 4 },
  title: { fontSize: 14, fontWeight: '600' },
  text: { fontSize: 12, opacity: 0.8, lineHeight: 17 },
  action: { fontSize: 13, fontWeight: '600', paddingTop: 4 },
});
