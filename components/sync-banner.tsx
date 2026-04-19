import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useSyncProgress } from '@/hooks/use-sync-progress';

/**
 * Sticky banner surfaced by dashboard + jobs-list screens while a sync
 * run is in flight. Tap jumps to the job's detail screen where live
 * per-file progress is rendered inline. Returns null when no run is
 * active so the caller can render it unconditionally.
 */
export function SyncBanner() {
  const snap = useSyncProgress();
  const router = useRouter();
  const scheme = useColorScheme() ?? 'light';

  const run = snap.activeRun;
  if (!run) return null;

  const file = run.activeFile;
  const pct =
    file && file.size > 0 ? Math.min(100, Math.round((file.bytesUploaded / file.size) * 100)) : 0;

  const label =
    run.phase === 'scanning'
      ? 'Scanning…'
      : run.phase === 'finalizing'
        ? 'Finalizing…'
        : file
          ? `${file.name} · ${pct}%`
          : 'Syncing…';

  return (
    <Pressable
      onPress={() => router.push(`/job/${run.jobId}`)}
      style={({ pressed }) => [
        styles.banner,
        { backgroundColor: Colors[scheme].tint, opacity: pressed ? 0.85 : 1 },
      ]}
      accessibilityLabel="Open active sync job">
      <IconSymbol name="arrow.triangle.2.circlepath" color="#fff" size={18} />
      <View style={styles.text}>
        <ThemedText style={styles.title}>Sync running</ThemedText>
        <ThemedText style={styles.subtitle} numberOfLines={1}>
          {label}
        </ThemedText>
      </View>
      <View style={styles.counters}>
        <ThemedText style={styles.counter}>
          {run.counters.uploaded}/{run.counters.scanned}
        </ThemedText>
        {run.counters.failed > 0 ? (
          <ThemedText style={[styles.counter, styles.failed]}>
            {run.counters.failed} failed
          </ThemedText>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginHorizontal: 16,
    marginBottom: 8,
    gap: 10,
    borderRadius: 10,
  },
  text: { flex: 1, minWidth: 0 },
  title: { color: '#fff', fontWeight: '600', fontSize: 14 },
  subtitle: { color: '#fff', fontSize: 12, opacity: 0.9 },
  counters: { alignItems: 'flex-end' },
  counter: { color: '#fff', fontSize: 12 },
  failed: { fontWeight: '600' },
});
