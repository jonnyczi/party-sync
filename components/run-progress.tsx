import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { formatEta, formatRate, useEta } from '@/hooks/use-eta';
import { basename, formatBytes } from '@/src/format';
import type { ActiveRunSnapshot } from '@/src/sync/progress';

/**
 * Live progress body for the active sync run: progress bar, byte/percent
 * line with smoothed rate + ETA, in-flight file list, counters, dedup
 * savings, and the tail of any errors. Shared by the dashboard hero card
 * and the job overview so the two can't drift apart; callers provide their
 * own chrome (header, cancel affordance, borders).
 */
export function RunProgress({
  run,
  maxFiles = 4,
}: {
  run: ActiveRunSnapshot;
  maxFiles?: number;
}) {
  const scheme = useColorScheme() ?? 'light';
  const { etaMs, rateBytesPerSec } = useEta(
    run.uploadedBytes,
    run.totalBytes,
    run.startedAt,
  );
  const pct =
    run.totalBytes > 0
      ? Math.min(100, Math.round((run.uploadedBytes / run.totalBytes) * 100))
      : 0;
  const eta = formatEta(etaMs);
  const rate = formatRate(rateBytesPerSec);

  return (
    <View style={styles.body}>
      <View style={[styles.progressTrack, { backgroundColor: Colors[scheme].border }]}>
        <View
          style={[
            styles.progressFill,
            { width: `${pct}%`, backgroundColor: Colors[scheme].accent },
          ]}
        />
      </View>
      <View style={styles.progressRow}>
        <ThemedText style={styles.muted}>
          {formatBytes(run.uploadedBytes)} / {formatBytes(run.totalBytes)} ({pct}%)
        </ThemedText>
        <ThemedText style={styles.muted}>
          {[rate, eta].filter(Boolean).join(' · ')}
        </ThemedText>
      </View>
      {run.activeFiles.length > 0 ? (
        <View style={styles.files}>
          {run.activeFiles.slice(0, maxFiles).map((f) => {
            const fpct =
              f.size > 0
                ? Math.min(100, Math.round((f.bytesUploaded / f.size) * 100))
                : 0;
            return (
              <View key={f.localPath} style={styles.fileRow}>
                <ThemedText numberOfLines={1} style={styles.fileName}>
                  {f.name}
                </ThemedText>
                <ThemedText style={styles.filePct}>{fpct}%</ThemedText>
              </View>
            );
          })}
          {run.activeFiles.length > maxFiles ? (
            <ThemedText style={styles.muted}>
              +{run.activeFiles.length - maxFiles} more uploading…
            </ThemedText>
          ) : null}
        </View>
      ) : null}
      <ThemedText style={styles.muted}>
        {run.counters.uploaded} uploaded · {run.counters.skipped} skipped ·{' '}
        {run.counters.failed} failed
      </ThemedText>
      {run.dedupedBytes > 0 ? (
        <ThemedText style={[styles.small, { color: Colors[scheme].success }]}>
          saved {formatBytes(run.dedupedBytes)} via dedup
        </ThemedText>
      ) : null}
      {run.errors.length > 0 ? (
        <View style={styles.errors}>
          {run.errors.slice(-3).map((e, i) => (
            <ThemedText
              key={i}
              style={[styles.small, { color: Colors[scheme].danger }]}
              numberOfLines={1}>
              {e.phase}: {basename(e.localPath) || '(run)'} —{' '}
              {e.message ?? `HTTP ${e.httpStatus}`}
            </ThemedText>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** "Scanning…" / "Uploading" / "Finalizing…" */
export function phaseLabel(phase: ActiveRunSnapshot['phase']): string {
  if (phase === 'scanning') return 'Scanning…';
  if (phase === 'finalizing') return 'Finalizing…';
  return 'Uploading';
}

const styles = StyleSheet.create({
  body: { gap: 6 },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: { height: '100%' },
  progressRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  files: { marginTop: 2, gap: 2 },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fileName: { flex: 1, fontSize: 13, opacity: 0.85 },
  filePct: { fontSize: 13, opacity: 0.7, fontVariant: ['tabular-nums'] },
  muted: { fontSize: 12, opacity: 0.7 },
  small: { fontSize: 12 },
  errors: { marginTop: 4, gap: 2 },
});
