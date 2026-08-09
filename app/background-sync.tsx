import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import CopypartySync from '@/modules/copyparty-sync';
import type { HealthFix, HealthItem, HealthStatus } from '@/src/sync/health-eval';
import { readSyncHealth } from '@/src/sync/health';

/**
 * Background-sync health checklist: one row per device setting that can stop
 * or degrade background sync, each with a one-tap Fix shortcut into the right
 * system screen. Reached from Settings, the dashboard warning card, and the
 * job form's periodic-sync check.
 */
export default function BackgroundSyncScreen() {
  const scheme = useColorScheme() ?? 'light';
  const [items, setItems] = useState<HealthItem[]>([]);

  const probe = useCallback(() => {
    readSyncHealth()
      .then(setItems)
      .catch((e) => console.warn('[copyparty] health probe failed', e));
  }, []);

  // Probe on mount and every time the app comes back to the foreground — the
  // user returns from a system settings screen without a router focus change,
  // so AppState is the signal that a Fix may have landed.
  useEffect(() => {
    probe();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') probe();
    });
    return () => sub.remove();
  }, [probe]);

  const onFix = useCallback(async (item: HealthItem) => {
    try {
      switch (item.fix) {
        case 'battery_dialog':
          await CopypartySync?.requestIgnoreBatteryOptimizations();
          break;
        case 'app_settings':
          await CopypartySync?.openAppSettings();
          break;
        case 'data_saver_settings':
          await CopypartySync?.openDataSaverSettings();
          break;
        case 'web_guide':
          if (item.url) await WebBrowser.openBrowserAsync(item.url);
          break;
      }
    } catch (e) {
      console.warn('[copyparty] health fix failed', e);
    }
  }, []);

  if (Platform.OS !== 'android') {
    return (
      <ThemedView style={[styles.container, styles.centered]}>
        <ThemedText style={styles.dim}>
          Background-sync setup only applies to Android.
        </ThemedText>
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <ThemedText style={styles.blurb}>
          Android limits what apps may do in the background. These device
          settings decide whether scheduled syncs run reliably while the app is
          closed — fix anything marked below.
        </ThemedText>

        {items.map((item) => (
          <HealthRow key={item.id} item={item} scheme={scheme} onFix={onFix} />
        ))}
      </ScrollView>
    </ThemedView>
  );
}

function HealthRow({
  item,
  scheme,
  onFix,
}: {
  item: HealthItem;
  scheme: 'light' | 'dark';
  onFix: (item: HealthItem) => void;
}) {
  const c = Colors[scheme];
  return (
    <View style={[styles.row, { borderColor: c.border }]}>
      <IconSymbol
        name={statusIcon(item.status)}
        color={statusTint(item.status, scheme)}
        size={22}
      />
      <View style={styles.rowBody}>
        <ThemedText type="defaultSemiBold">{item.title}</ThemedText>
        <ThemedText style={styles.detail}>{item.detail}</ThemedText>
        {item.fix ? (
          <Pressable
            onPress={() => onFix(item)}
            accessibilityLabel={`Fix ${item.title}`}
            style={({ pressed }) => [
              styles.fixButton,
              { borderColor: c.tint, opacity: pressed ? 0.6 : 1 },
            ]}>
            <ThemedText style={[styles.fixLabel, { color: c.tint }]}>
              {fixLabel(item.fix)}
            </ThemedText>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function statusIcon(status: HealthStatus) {
  switch (status) {
    case 'ok':
      return 'checkmark.circle.fill' as const;
    case 'warn':
      return 'exclamationmark.triangle.fill' as const;
    case 'blocked':
      return 'xmark.circle.fill' as const;
  }
}

function statusTint(status: HealthStatus, scheme: 'light' | 'dark'): string {
  const c = Colors[scheme];
  switch (status) {
    case 'ok':
      return c.success;
    case 'warn':
      return c.warning;
    case 'blocked':
      return c.danger;
  }
}

function fixLabel(fix: HealthFix): string {
  switch (fix) {
    case 'battery_dialog':
      return 'Allow exemption';
    case 'app_settings':
      return 'Open app settings';
    case 'data_saver_settings':
      return 'Open Data Saver settings';
    case 'web_guide':
      return 'Open guide';
  }
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: 16, gap: 12 },
  blurb: { opacity: 0.7, fontSize: 14, marginBottom: 4 },
  row: {
    flexDirection: 'row',
    gap: 12,
    padding: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'flex-start',
  },
  rowBody: { flex: 1, gap: 4 },
  detail: { opacity: 0.7, fontSize: 13, lineHeight: 18 },
  fixButton: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginTop: 4,
  },
  fixLabel: { fontSize: 14, fontWeight: '600' },
  dim: { opacity: 0.6 },
});
