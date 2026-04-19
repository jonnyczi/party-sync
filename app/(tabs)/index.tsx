import { useFocusEffect, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { SyncBanner } from '@/components/sync-banner';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { listJobs } from '@/src/db/jobs';
import { getLatestRunForJob } from '@/src/db/runs';
import type { JobRow, RunRow } from '@/src/db/types';

interface DashboardItem {
  job: JobRow;
  lastRun: RunRow | null;
}

export default function HomeScreen() {
  const db = useSQLiteContext();
  const router = useRouter();
  const [items, setItems] = useState<DashboardItem[]>([]);

  const refresh = useCallback(async () => {
    const jobs = await listJobs(db);
    const hydrated = await Promise.all(
      jobs.map(async (j) => ({ job: j, lastRun: await getLatestRunForJob(db, j.id) })),
    );
    setItems(hydrated);
  }, [db]);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  const totalUploaded = items.reduce((s, i) => s + (i.lastRun?.files_uploaded ?? 0), 0);
  const totalFailed = items.reduce((s, i) => s + (i.lastRun?.files_failed ?? 0), 0);

  return (
    <ThemedView style={styles.container}>
      <View style={styles.header}>
        <ThemedText type="title">Dashboard</ThemedText>
      </View>

      <SyncBanner />

      <ScrollView contentContainerStyle={styles.scroll}>
        {items.length === 0 ? (
          <View style={styles.empty}>
            <ThemedText type="subtitle">Nothing to sync yet</ThemedText>
            <ThemedText style={styles.emptyHint}>
              Add a server in Settings, then configure a sync job in the Jobs tab.
            </ThemedText>
          </View>
        ) : (
          <>
            <View style={styles.summary}>
              <SummaryCell label="Jobs" value={String(items.length)} />
              <SummaryCell label="Uploaded (last run)" value={String(totalUploaded)} />
              <SummaryCell
                label="Failed (last run)"
                value={String(totalFailed)}
                bad={totalFailed > 0}
              />
            </View>

            <ThemedText type="subtitle" style={styles.sectionHeader}>
              Jobs
            </ThemedText>
            {items.map((item) => (
              <Pressable
                key={item.job.id}
                onPress={() => router.push(`/job/${item.job.id}`)}
                style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}>
                <View style={{ flex: 1, gap: 3 }}>
                  <ThemedText type="defaultSemiBold">{item.job.name}</ThemedText>
                  <ThemedText style={styles.rowSub} numberOfLines={1}>
                    {item.job.remote_path}
                  </ThemedText>
                  <RunLine run={item.lastRun} />
                </View>
              </Pressable>
            ))}
          </>
        )}
      </ScrollView>
    </ThemedView>
  );
}

function SummaryCell({
  label,
  value,
  bad,
}: {
  label: string;
  value: string;
  bad?: boolean;
}) {
  return (
    <View style={styles.summaryCell}>
      <ThemedText type="title" style={bad ? { color: '#c33' } : undefined}>
        {value}
      </ThemedText>
      <ThemedText style={styles.summaryLabel}>{label}</ThemedText>
    </View>
  );
}

function RunLine({ run }: { run: RunRow | null }) {
  if (!run) {
    return <ThemedText style={styles.runMuted}>Never synced</ThemedText>;
  }
  const color =
    run.status === 'ok'
      ? '#2a9d3f'
      : run.status === 'partial'
        ? '#d08900'
        : run.status === 'failed'
          ? '#c33'
          : '#888';
  return (
    <View style={styles.runLine}>
      <View style={[styles.statusDot, { backgroundColor: color }]} />
      <ThemedText style={styles.runText} numberOfLines={1}>
        {new Date(run.started_at).toLocaleString()} · {run.status}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 56 },
  header: { paddingHorizontal: 16, paddingBottom: 12 },
  scroll: { paddingBottom: 24 },
  summary: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  summaryCell: {
    flex: 1,
    padding: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#8884',
    alignItems: 'flex-start',
  },
  summaryLabel: { fontSize: 12, opacity: 0.7, marginTop: 2 },
  sectionHeader: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  row: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#8882',
  },
  rowSub: { opacity: 0.7, fontSize: 13 },
  runLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  runText: { opacity: 0.7, fontSize: 12, flexShrink: 1 },
  runMuted: { opacity: 0.5, fontSize: 12, fontStyle: 'italic' },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  empty: { paddingHorizontal: 24, paddingTop: 48, gap: 8 },
  emptyHint: { opacity: 0.7 },
});
