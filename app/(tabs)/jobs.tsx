import { useFocusEffect, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SyncBanner } from '@/components/sync-banner';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { statusColor } from '@/constants/status-colors';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useSyncAll } from '@/hooks/use-sync-all';
import { useSyncProgress } from '@/hooks/use-sync-progress';
import { deleteJob, listJobs } from '@/src/db/jobs';
import { listServers } from '@/src/db/servers';
import { getLatestRunForJob } from '@/src/db/runs';
import type { JobRow, RunRow, ServerRow } from '@/src/db/types';
import { runJobManual } from '@/src/sync/triggers/manual';
import {
  requestCancelAll,
  runAllJobsManual,
} from '@/src/sync/triggers/sync-all';

interface JobRowView {
  job: JobRow;
  serverName: string;
  lastRun: RunRow | null;
}

export default function JobsScreen() {
  const db = useSQLiteContext();
  const router = useRouter();
  const scheme = useColorScheme() ?? 'light';
  const insets = useSafeAreaInsets();
  const [rows, setRows] = useState<JobRowView[]>([]);
  const [hasServers, setHasServers] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const { activeRun } = useSyncProgress();
  const { batch } = useSyncAll();
  // Bridges the gap between tapping a row's sync button and the engine's
  // first progress event, so the button can't double-fire.
  const [startingJobId, setStartingJobId] = useState<number | null>(null);

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
      refresh().catch((e) => console.warn('jobs refresh failed', e));
    }, [refresh]),
  );

  // When a run finishes while this tab is focused, the SyncBanner clears itself
  // (it reads the bus) but each row's last-run summary is DB-backed — refresh it
  // so the row reflects the just-completed run instead of staying stale.
  const prevActive = useRef(false);
  useEffect(() => {
    if (prevActive.current && !activeRun) {
      refresh().catch((e) => console.warn('jobs refresh failed', e));
    }
    prevActive.current = activeRun !== null;
  }, [activeRun, refresh]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    refresh()
      .catch((e) => console.warn('jobs refresh failed', e))
      .finally(() => setRefreshing(false));
  }, [refresh]);

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
        'Sync jobs need a copyparty server to upload to. Add one from the Servers tab, then come back here.',
      );
      return;
    }
    router.push('/job/new');
  };

  const onSyncRow = (row: JobRowView) => {
    if (activeRun || batch || startingJobId !== null) return;
    setStartingJobId(row.job.id);
    // Resolves when the run finishes; live state comes from the progress bus.
    runJobManual(db, row.job.id)
      .catch((e) => {
        Alert.alert('Sync failed', e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        setStartingJobId(null);
        refresh().catch(() => {});
      });
  };

  const anyBusy = activeRun !== null || batch !== null || startingJobId !== null;
  const hasRunnableJob = rows.some(
    (r) => !(r.job.source_kind === 'saf' && r.job.source_uri === ''),
  );

  const onSyncAll = () => {
    if (anyBusy || !hasRunnableJob) return;
    // Resolves when the whole batch finishes; live state comes from the
    // sync-all + progress buses.
    runAllJobsManual(db)
      .then((res) => {
        if (res.failedToStart.length > 0) {
          Alert.alert(
            `${res.failedToStart.length} job${res.failedToStart.length === 1 ? '' : 's'} could not start`,
            res.failedToStart.map((f) => `${f.name}: ${f.message}`).join('\n'),
          );
        }
      })
      .catch((e) => {
        Alert.alert('Sync all failed', e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        refresh().catch(() => {});
      });
  };

  return (
    <ThemedView style={[styles.container, { paddingTop: insets.top + 8 }]}>
      <View style={styles.header}>
        <ThemedText type="title">Jobs</ThemedText>
        <View style={styles.headerActions}>
          {batch ? (
            <Pressable
              onPress={requestCancelAll}
              style={({ pressed }) => [
                styles.syncAllBtn,
                { borderColor: Colors[scheme].danger, opacity: pressed ? 0.7 : 1 },
              ]}
              accessibilityLabel="Stop syncing all jobs">
              <IconSymbol name="xmark.circle.fill" color={Colors[scheme].danger} size={16} />
              <ThemedText style={[styles.syncAllText, { color: Colors[scheme].danger }]}>
                Stop
              </ThemedText>
            </Pressable>
          ) : (
            <Pressable
              onPress={onSyncAll}
              disabled={anyBusy || !hasRunnableJob}
              style={({ pressed }) => [
                styles.syncAllBtn,
                {
                  borderColor: Colors[scheme].tint,
                  opacity: anyBusy || !hasRunnableJob ? 0.4 : pressed ? 0.7 : 1,
                },
              ]}
              accessibilityLabel="Sync all jobs now">
              <IconSymbol
                name="arrow.triangle.2.circlepath"
                color={Colors[scheme].tint}
                size={16}
              />
              <ThemedText style={[styles.syncAllText, { color: Colors[scheme].tint }]}>
                Sync all
              </ThemedText>
            </Pressable>
          )}
          <Pressable
            onPress={onAdd}
            style={({ pressed }) => [
              styles.addBtn,
              { backgroundColor: Colors[scheme].accent, opacity: pressed ? 0.7 : 1 },
            ]}
            accessibilityLabel="Add job">
            <IconSymbol name="plus" color={Colors[scheme].onAccent} size={20} />
            <ThemedText style={[styles.addBtnText, { color: Colors[scheme].onAccent }]}>
              Add
            </ThemedText>
          </Pressable>
        </View>
      </View>

      <SyncBanner />

      {rows.length === 0 ? (
        <View style={styles.empty}>
          <ThemedText type="subtitle">No sync jobs yet</ThemedText>
          <ThemedText style={styles.emptyHint}>
            {hasServers
              ? 'Add a job to pick a folder and a server to back it up to.'
              : 'Configure a server first in the Servers tab, then come back and add a job.'}
          </ThemedText>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => String(r.job.id)}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={Colors[scheme].icon}
            />
          }
          renderItem={({ item }) => {
            const isActiveHere =
              activeRun?.jobId === item.job.id || startingJobId === item.job.id;
            const syncBlocked = anyBusy && !isActiveHere;
            const needsSource =
              item.job.source_kind === 'saf' && item.job.source_uri === '';
            return (
              <Pressable
                onPress={() => router.push(`/job/${item.job.id}`)}
                onLongPress={() => confirmDelete(item)}
                style={({ pressed }) => [
                  styles.row,
                  { borderBottomColor: Colors[scheme].border, opacity: pressed ? 0.6 : 1 },
                ]}>
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
                  {needsSource ? (
                    <ThemedText
                      style={[styles.needsSource, { color: Colors[scheme].warning }]}
                      numberOfLines={1}>
                      ⚠ Source not set — tap to choose a folder
                    </ThemedText>
                  ) : (
                    <RunSummary run={item.lastRun} />
                  )}
                </View>
                {isActiveHere ? (
                  <View style={styles.syncBtn}>
                    <ActivityIndicator size="small" color={Colors[scheme].accent} />
                  </View>
                ) : (
                  <Pressable
                    onPress={() => onSyncRow(item)}
                    disabled={syncBlocked || needsSource}
                    hitSlop={6}
                    accessibilityLabel={`Sync ${item.job.name} now`}
                    style={({ pressed }) => [
                      styles.syncBtn,
                      { opacity: syncBlocked || needsSource ? 0.3 : pressed ? 0.5 : 1 },
                    ]}>
                    <IconSymbol
                      name="arrow.up.circle.fill"
                      color={Colors[scheme].accent}
                      size={28}
                    />
                  </Pressable>
                )}
                <IconSymbol name="chevron.right" color={Colors[scheme].icon} size={20} />
              </Pressable>
            );
          }}
        />
      )}
    </ThemedView>
  );
}

function RunSummary({ run }: { run: RunRow | null }) {
  const scheme = useColorScheme() ?? 'light';
  if (!run) {
    return <ThemedText style={styles.runMuted}>Never synced</ThemedText>;
  }
  const when = new Date(run.started_at).toLocaleString();
  return (
    <View style={styles.runLine}>
      <View style={[styles.statusDot, { backgroundColor: statusColor(run.status, scheme) }]} />
      <ThemedText style={styles.runText} numberOfLines={1}>
        {when} · {run.status} · {run.files_uploaded} up, {run.files_skipped} skipped
        {run.files_failed > 0 ? `, ${run.files_failed} failed` : ''}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  addBtnText: { fontWeight: '600' },
  syncAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  syncAllText: { fontWeight: '600', fontSize: 14 },
  list: { paddingHorizontal: 16, paddingBottom: 24 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowMain: { flex: 1, gap: 4 },
  rowSub: { opacity: 0.7, fontSize: 13 },
  runLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  runText: { opacity: 0.7, fontSize: 13, flexShrink: 1 },
  runMuted: { opacity: 0.5, fontSize: 13, fontStyle: 'italic' },
  needsSource: { fontSize: 13 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  syncBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: { paddingHorizontal: 24, paddingTop: 48, gap: 8 },
  emptyHint: { opacity: 0.7 },
});
