import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useSyncAll } from '@/hooks/use-sync-all';
import { useSyncProgress } from '@/hooks/use-sync-progress';

/**
 * Sticky banner surfaced by dashboard + jobs-list screens while a sync
 * run is in flight. Tap jumps to the job's detail screen where live
 * per-file progress is rendered inline. Returns null when no run is
 * active so the caller can render it unconditionally.
 */
export function SyncBanner() {
  const snap = useSyncProgress();
  const { batch } = useSyncAll();
  const router = useRouter();
  const scheme = useColorScheme() ?? 'light';

  const run = snap.activeRun;
  if (!run) return null;

  const title = batch
    ? `Syncing all — job ${Math.min(batch.completed + 1, batch.total)} of ${batch.total}`
    : 'Sync running';

  const onAccent = Colors[scheme].onAccent;
  const pct =
    run.totalBytes > 0
      ? Math.min(100, Math.round((run.uploadedBytes / run.totalBytes) * 100))
      : 0;
  const inFlight = run.activeFiles.length;

  const label =
    run.phase === 'scanning'
      ? 'Scanning…'
      : run.phase === 'finalizing'
        ? 'Finalizing…'
        : inFlight > 0
          ? `${inFlight} file${inFlight === 1 ? '' : 's'} · ${pct}%`
          : 'Syncing…';

  return (
    <Pressable
      onPress={() => router.push(`/job/${run.jobId}`)}
      style={({ pressed }) => [
        styles.banner,
        { backgroundColor: Colors[scheme].accent, opacity: pressed ? 0.85 : 1 },
      ]}
      accessibilityLabel="Open active sync job">
      <IconSymbol name="arrow.triangle.2.circlepath" color={onAccent} size={18} />
      <View style={styles.text}>
        <ThemedText style={[styles.title, { color: onAccent }]}>{title}</ThemedText>
        <ThemedText style={[styles.subtitle, { color: onAccent }]} numberOfLines={1}>
          {label}
        </ThemedText>
      </View>
      <View style={styles.counters}>
        {/* Counted against the work list, not everything walked — the same
            denominator the percentage beside it uses. On a mostly-synced job
            `scanned` is dominated by skips that can never increment `uploaded`,
            so "10/120" read as stalled when the run was in fact 33% done. */}
        <ThemedText style={[styles.counter, { color: onAccent }]}>
          {run.counters.uploaded}/{run.totalFiles}
        </ThemedText>
        {run.counters.failed > 0 ? (
          <ThemedText style={[styles.counter, styles.failed, { color: onAccent }]}>
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
  title: { fontWeight: '600', fontSize: 14 },
  subtitle: { fontSize: 12, opacity: 0.9 },
  counters: { alignItems: 'flex-end' },
  counter: { fontSize: 12 },
  failed: { fontWeight: '600' },
});
