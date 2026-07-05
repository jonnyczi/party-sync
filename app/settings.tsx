import { useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Switch, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import {
  getResultNotificationsEnabled,
  setResultNotificationsEnabled,
} from '@/src/db/settings';
import CopypartySync from '@/modules/copyparty-sync';
import { requestNotificationPermission } from '@/src/sync/notify-permission';

/**
 * App-wide settings, reached via the gear in the Dashboard header. Holds
 * the rarely-touched knobs: the sync-result notifications kill-switch and
 * the Backup & restore entry point.
 */
export default function SettingsScreen() {
  const db = useSQLiteContext();
  const router = useRouter();
  const scheme = useColorScheme() ?? 'light';
  const [notifyEnabled, setNotifyEnabled] = useState(true);

  useEffect(() => {
    getResultNotificationsEnabled(db)
      .then(setNotifyEnabled)
      .catch((e) => console.warn('settings load failed', e));
  }, [db]);

  // Master kill-switch for sync result notifications. Enabling requests
  // POST_NOTIFICATIONS (Android 13+); if denied, revert to off so the toggle
  // reflects reality.
  const onToggleNotify = useCallback(
    async (next: boolean) => {
      if (!next) {
        setNotifyEnabled(false);
        await setResultNotificationsEnabled(db, false);
        return;
      }
      try {
        const perm = await requestNotificationPermission();
        if (perm !== 'granted') {
          // 'blocked' means Android will never re-prompt — only the system
          // settings page can flip it, so offer the shortcut.
          Alert.alert(
            'Notifications disabled',
            'Allow notifications for copyparty in system settings to get sync result alerts.',
            perm === 'blocked'
              ? [
                  { text: 'Not now', style: 'cancel' },
                  {
                    text: 'Open settings',
                    onPress: () => {
                      CopypartySync?.openNotificationSettings().catch(() => {});
                    },
                  },
                ]
              : undefined,
          );
          setNotifyEnabled(false);
          await setResultNotificationsEnabled(db, false);
          return;
        }
        setNotifyEnabled(true);
        await setResultNotificationsEnabled(db, true);
      } catch (e) {
        Alert.alert(
          'Could not enable notifications',
          e instanceof Error ? e.message : String(e),
        );
      }
    },
    [db],
  );

  return (
    <ThemedView style={styles.container}>
      <View style={styles.section}>
        <ThemedText type="subtitle">Notifications</ThemedText>
        <View style={styles.toggleRow}>
          <View style={styles.toggleText}>
            <ThemedText type="defaultSemiBold">Sync results</ThemedText>
            <ThemedText style={styles.rowSub}>
              Notify when a sync finishes or fails. Per-job in each job&apos;s settings.
            </ThemedText>
          </View>
          <Switch value={notifyEnabled} onValueChange={onToggleNotify} />
        </View>
      </View>

      <View style={styles.section}>
        <ThemedText type="subtitle">Sync</ThemedText>
        <Pressable
          onPress={() => router.push('/background-sync')}
          style={({ pressed }) => [
            styles.navRow,
            { borderColor: Colors[scheme].border, opacity: pressed ? 0.6 : 1 },
          ]}
          accessibilityLabel="Background sync setup">
          <IconSymbol
            name="arrow.triangle.2.circlepath"
            color={Colors[scheme].tint}
            size={20}
          />
          <View style={{ flex: 1, gap: 2 }}>
            <ThemedText type="defaultSemiBold">Background sync</ThemedText>
            <ThemedText style={styles.rowSub}>
              Check device settings that can block scheduled syncs.
            </ThemedText>
          </View>
          <IconSymbol name="chevron.right" color={Colors[scheme].icon} size={18} />
        </Pressable>
      </View>

      <View style={styles.section}>
        <ThemedText type="subtitle">Data</ThemedText>
        <Pressable
          onPress={() => router.push('/backup')}
          style={({ pressed }) => [
            styles.navRow,
            { borderColor: Colors[scheme].border, opacity: pressed ? 0.6 : 1 },
          ]}
          accessibilityLabel="Backup and restore">
          <IconSymbol name="arrow.up.arrow.down" color={Colors[scheme].tint} size={20} />
          <View style={{ flex: 1, gap: 2 }}>
            <ThemedText type="defaultSemiBold">Backup &amp; restore</ThemedText>
            <ThemedText style={styles.rowSub}>
              Export or import your servers and sync jobs.
            </ThemedText>
          </View>
          <IconSymbol name="chevron.right" color={Colors[scheme].icon} size={18} />
        </Pressable>
      </View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 24 },
  section: { gap: 10 },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  toggleText: { flex: 1, gap: 2 },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  rowSub: { opacity: 0.7, fontSize: 13 },
});
