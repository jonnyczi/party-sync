import { useFocusEffect, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, View } from 'react-native';

import { SyncBanner } from '@/components/sync-banner';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { deleteJob, listJobs } from '@/src/db/jobs';
import { listServers } from '@/src/db/servers';
import { getLatestRunForJob } from '@/src/db/runs';
import type { JobRow, RunRow, ServerRow } from '@/src/db/types';

interface JobRowView {
  job: JobRow;
  serverName: string;
  lastRun: RunRow | null;
}

export default function JobsScreen() {
  const db = useSQLiteContext();
  const router = useRouter();
  const scheme = useColorScheme() ?? 'light';
  const [rows, setRows] = useState<JobRowView[]>([]);
  const [hasServers, setHasServers] = useState(true);

  const refresh = useCallback(async () => {
    const [jobs, servers] = await Promise.all([listJobs(db), listServers(db)]);
    setHasServers(servers.length > 0);
    const serversById = new Map<number, ServerRow>(servers.map((s) => [s.id, s]));
    const withRuns = await Promise.all(
      jobs.map(async (j) => ({
        job: j,
        serverName: serversById.get(j.server_id)?.name ?? '(missing server)',
        lastRun: await getLatestRunForJob(db, j.id),
      })),
    );
    setRows(withRuns);
  }, [db]);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  const confirmDelete = (row: JobRowView) => {
    Alert.alert(
      `Delete ${row.job.name}?`,
      'This removes the job and its sync history. Files already on the server are untouched.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await deleteJob(db, row.job.id);
            refresh();
          },
        },
      ],
    );
  };

  const onAdd = () => {
    if (!hasServers) {
      Alert.alert(
        'Add a server first',
        'Sync jobs need a copyparty server to upload to. Add one from the Settings tab, then come back here.',
      );
      return;
    }
    router.push('/job/new');
  };

  return (
    <ThemedView style={styles.container}>
      <View style={styles.header}>
        <ThemedText type="title">Jobs</ThemedText>
        <Pressable
          onPress={onAdd}
          style={({ pressed }) => [
            styles.addBtn,
            { backgroundColor: Colors[scheme].tint, opacity: pressed ? 0.7 : 1 },
          ]}
          accessibilityLabel="Add job">
          <IconSymbol name="plus" color="#fff" size={20} />
          <ThemedText style={styles.addBtnText}>Add</ThemedText>
        </Pressable>
      </View>

      <SyncBanner />

      {rows.length === 0 ? (
        <View style={styles.empty}>
          <ThemedText type="subtitle">No sync jobs yet</ThemedText>
          <ThemedText style={styles.emptyHint}>
            {hasServers
              ? 'Add a job to pick a folder and a server to back it up to.'
              : 'Configure a server first in Settings, then come back and add a job.'}
          </ThemedText>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => String(r.job.id)}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push(`/job/${item.job.id}`)}
              onLongPress={() => confirmDelete(item)}
              style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}>
              <IconSymbol
                name={item.job.source_kind === 'media' ? 'photo.on.rectangle' : 'folder.fill'}
                color={Colors[scheme].icon}
                size={22}
              />
              <View style={styles.rowMain}>
                <ThemedText type="defaultSemiBold">{item.job.name}</ThemedText>
                <ThemedText style={styles.rowSub} numberOfLines={1}>
                  {item.serverName} → {item.job.remote_path}
                </ThemedText>
                {item.job.source_kind === 'saf' && item.job.source_uri === '' ? (
                  <ThemedText style={styles.needsSource} numberOfLines={1}>
                    ⚠ Source not set — tap to choose a folder
                  </ThemedText>
                ) : (
                  <RunSummary run={item.lastRun} />
                )}
              </View>
              <IconSymbol name="chevron.right" color={Colors[scheme].icon} size={20} />
            </Pressable>
          )}
        />
      )}
    </ThemedView>
  );
}

function RunSummary({ run }: { run: RunRow | null }) {
  if (!run) {
    return <ThemedText style={styles.runMuted}>Never synced</ThemedText>;
  }
  const when = new Date(run.started_at).toLocaleString();
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
        {when} · {run.status} · {run.files_uploaded} up, {run.files_skipped} skipped
        {run.files_failed > 0 ? `, ${run.files_failed} failed` : ''}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 56 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  addBtnText: { color: '#fff', fontWeight: '600' },
  list: { paddingHorizontal: 16, paddingBottom: 24 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#8882',
  },
  rowMain: { flex: 1, gap: 4 },
  rowSub: { opacity: 0.7, fontSize: 13 },
  runLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  runText: { opacity: 0.7, fontSize: 12, flexShrink: 1 },
  runMuted: { opacity: 0.5, fontSize: 12, fontStyle: 'italic' },
  needsSource: { color: '#d08900', fontSize: 12 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  empty: { paddingHorizontal: 24, paddingTop: 48, gap: 8 },
  emptyHint: { opacity: 0.7 },
});
