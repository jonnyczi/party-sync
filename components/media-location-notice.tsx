import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { getOriginalBytesState } from '@/src/media/media-permission';
import { requestOriginalBytesWithEscalation } from '@/src/media/request-original-bytes';

/** Camera-roll jobs vs Folder jobs — same defect, different explanation owed. */
export type MediaLocationVariant = 'media' | 'folder';

const COPY: Record<
  MediaLocationVariant,
  { title: string; body: string; action: string }
> = {
  media: {
    title: 'Photos are backed up without location',
    body:
      'Android removes the GPS tag from photos this app reads unless you allow it. ' +
      'Backed-up photos lose their location, and may upload a second copy instead of ' +
      'being recognised as already on your server.',
    action: 'Allow photo location',
  },
  folder: {
    // A folder-backup job asking about photos looks like overreach unless the
    // "even one you picked yourself" part is said out loud.
    title: 'Photos in this folder lose their location',
    body:
      'Android blanks the GPS tag out of any photo an app reads — even a photo in a ' +
      'folder you picked yourself. Those photos get backed up without their location, ' +
      'and your server cannot tell they are the same photos it already has, so it ' +
      'keeps a second copy.',
    action: 'Allow photos to be read unedited',
  },
};

/**
 * Shown on any job that may read photos, when the app can't get their original
 * bytes.
 *
 * Without ACCESS_MEDIA_LOCATION Android zero-fills the EXIF GPS block in every
 * geotagged photo we read, so the backup silently differs from the originals and
 * can never dedup against a copy made any other way. That's invisible from
 * inside the app — uploads succeed, sizes match — so it needs a standing notice
 * rather than a one-off toast.
 *
 * This applies to Folder jobs too, and device-dependently: an Android 16 / One UI
 * handset redacts photos read through a user-picked folder, while a stock AOSP
 * build at API 35 does not. Since we can't tell from here, the notice shows on
 * every Folder job — noise on the devices that don't need it beats silent data
 * loss on the ones that do.
 *
 * Deliberately does not re-prompt on its own: Android stops showing the dialog
 * after two denials, at which point the settings shortcut is the only way back.
 * Renders nothing once satisfied (or where nothing is redacted).
 */
export function MediaLocationNotice({
  variant = 'media',
  onChange,
}: { variant?: MediaLocationVariant; onChange?: () => void } = {}) {
  const scheme = useColorScheme() ?? 'light';
  const [denied, setDenied] = useState(false);

  const refresh = useCallback(async () => {
    setDenied((await getOriginalBytesState()) === 'needs_permission');
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

  const settle = useCallback(() => {
    setDenied(false);
    onChange?.();
  }, [onChange]);

  const onGrant = useCallback(() => {
    void requestOriginalBytesWithEscalation(settle);
  }, [settle]);

  if (!denied) return null;

  const icon = Colors[scheme].icon;
  const tint = Colors[scheme].tint;

  const copy = COPY[variant];

  return (
    <View style={[styles.notice, { borderColor: icon }]}>
      <IconSymbol name="exclamationmark.triangle.fill" color={icon} size={16} />
      <View style={styles.body}>
        <ThemedText style={styles.title}>{copy.title}</ThemedText>
        <ThemedText style={styles.text}>{copy.body}</ThemedText>
        <ThemedText style={styles.text}>
          This applies to photos backed up from now on — it does not change copies already on
          your server.
        </ThemedText>
        <Pressable onPress={onGrant} accessibilityRole="button">
          <ThemedText style={[styles.action, { color: tint }]}>{copy.action}</ThemedText>
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
