import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
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

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { statusColor } from '@/constants/status-colors';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useSyncProgress } from '@/hooks/use-sync-progress';
import { getJob } from '@/src/db/jobs';
import { getRun, listRunErrors } from '@/src/db/runs';
import { getServer } from '@/src/db/servers';
import type {
  JobRow,
  RunErrorRow,
  RunRow,
  ServerRow,
} from '@/src/db/types';
import { formatBytes, formatDuration } from '@/src/format';
import { retryRunFailures } from '@/src/sync/triggers/retry';

interface LoadedRun {
  run: RunRow;
  job: JobRow;
  server: ServerRow | null;
  errors: RunErrorRow[];
}

export default function RunDetailScreen() {
  const { id: idParam } = useLocalSearchParams<{ id: string }>();
  const db = useSQLiteContext();
  const router = useRouter();
  const scheme = useColorScheme() ?? 'light';
  const runId = Number(idParam);
  const [data, setData] = useState<LoadedRun | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const { activeRun } = useSyncProgress();

  const load = useCallback(async () => {
    if (!Number.isFinite(runId)) {
      setNotFound(true);
      return;
    }
    const run = await getRun(db, runId);
    if (!run) {
      setNotFound(true);
      return;
    }
    const [job, errors] = await Promise.all([
      getJob(db, run.job_id),
      listRunErrors(db, run.id),
    ]);
    if (!job) {
      setNotFound(true);
      return;
    }
    const server = await getServer(db, job.server_id);
    setData({ run, job, server, errors });
  }, [db, runId]);

  // Initial load. Surface failures instead of silently no-opping.
  useEffect(() => {
    load().catch((e) => console.warn('run detail load failed', e));
  }, [load]);

  // While this run is the active one, the engine persists counters to the
  // `runs` row (~1s) and writes per-file errors immediately — so re-query on a
  // short interval to reflect progress live without leaving the screen.
  const isThisRunActive = activeRun?.runId === runId;
  useEffect(() => {
    if (!isThisRunActive) return;
    const t = setInterval(() => {
      load().catch(() => {});
    }, 1500);
    return () => clearInterval(t);
  }, [isThisRunActive, load]);

  // When the active run ends, reload once for the final status/counters/duration.
  const wasActive = useRef(false);
  useEffect(() => {
    if (isThisRunActive) {
      wasActive.current = true;
    } else if (wasActive.current) {
      wasActive.current = false;
      load().catch(() => {});
    }
  }, [isThisRunActive, load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load()
      .catch((e) => console.warn('run detail refresh failed', e))
      .finally(() => setRefreshing(false));
  }, [load]);

  if (notFound) {
    return (
      <ThemedView style={[styles.container, styles.centered]}>
        <Stack.Screen options={{ title: 'Run' }} />
        <ThemedText type="subtitle">Run not found</ThemedText>
      </ThemedView>
    );
  }
  if (!data) {
    return (
      <ThemedView style={[styles.container, styles.centered]}>
        <Stack.Screen options={{ title: 'Run' }} />
        <ActivityIndicator />
      </ThemedView>
    );
  }

  const { run, job, server, errors } = data;
  const duration =
    run.finished_at !== null ? formatDuration(run.finished_at - run.started_at) : '…';
  // Single-slot progress bus: a retry can't start while any run is active.
  const retryDisabled = retrying || activeRun !== null;
  // Disabled specifically because *another* run is in flight (not this screen's
  // own retry starting) — worth explaining so the greyed button isn't a mystery.
  const blockedByOtherRun = !retrying && activeRun !== null;

  const onRetry = () => {
    setRetrying(true);
    // Kick the retry off and navigate immediately: it runs via the foreground
    // service + progress bus, so the job screen's ActiveRunPanel shows it live.
    // The run continues regardless of this screen unmounting; we don't await it.
    retryRunFailures(db, run.id).catch((e) => {
      Alert.alert('Retry failed', e instanceof Error ? e.message : String(e));
    });
    router.push(`/job/${job.id}`);
  };

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: `Run #${run.id}` }} />
      <FlatList
        ListHeaderComponent={
          <View style={styles.header}>
            <View style={styles.titleRow}>
              <StatusPill status={run.status} />
              <ThemedText type="title" style={{ flexShrink: 1 }} numberOfLines={1}>
                {job.name}
              </ThemedText>
            </View>
            <ThemedText style={styles.meta} selectable>
              {server ? `${server.name} · ` : ''}
              {job.remote_path}
            </ThemedText>
            <ThemedText style={styles.meta}>
              {new Date(run.started_at).toLocaleString()} · {run.trigger} · {duration}
            </ThemedText>

            <View style={styles.statsGrid}>
              <Stat label="Scanned" value={String(run.files_scanned)} />
              <Stat label="Uploaded" value={String(run.files_uploaded)} />
              <Stat label="Skipped" value={String(run.files_skipped)} />
              <Stat
                label="Failed"
                value={String(run.files_failed)}
                bad={run.files_failed > 0}
              />
            </View>
            <ThemedText style={styles.bytesLine}>
              {formatBytes(run.bytes_uploaded)} uploaded
            </ThemedText>
            {run.bytes_deduped > 0 ? (
              <ThemedText style={[styles.dedupLine, { color: Colors[scheme].success }]}>
                {formatBytes(run.bytes_deduped)} saved via dedup
              </ThemedText>
            ) : null}

            {run.files_failed > 0 ? (
              <Pressable
                onPress={onRetry}
                disabled={retryDisabled}
                style={({ pressed }) => [
                  styles.retryBtn,
                  { backgroundColor: Colors[scheme].warning, opacity: retryDisabled ? 0.5 : pressed ? 0.8 : 1 },
                ]}>
                <IconSymbol name="arrow.clockwise" color={Colors[scheme].onAccent} size={16} />
                <ThemedText style={[styles.retryBtnText, { color: Colors[scheme].onAccent }]}>
                  {retrying ? 'Starting…' : `Retry failed (${run.files_failed})`}
                </ThemedText>
              </Pressable>
            ) : null}
            {run.files_failed > 0 && blockedByOtherRun ? (
              <ThemedText style={styles.retryHint}>
                A sync is already running — retry when it finishes.
              </ThemedText>
            ) : null}

            <Pressable
              onPress={() => router.push(`/job/${job.id}`)}
              style={({ pressed }) => [
                styles.openJobBtn,
                { borderColor: Colors[scheme].tint, opacity: pressed ? 0.7 : 1 },
              ]}>
              <IconSymbol name="folder.fill" color={Colors[scheme].tint} size={16} />
              <ThemedText style={{ color: Colors[scheme].tint, fontWeight: '600' }}>
                Open job
              </ThemedText>
            </Pressable>

            <View style={styles.sectionHeader}>
              <ThemedText type="subtitle">
                Errors{errors.length > 0 ? ` (${errors.length})` : ''}
              </ThemedText>
            </View>
            {errors.length === 0 ? (
              <ThemedText style={styles.emptyErrors}>
                No per-file errors for this run.
              </ThemedText>
            ) : null}
          </View>
        }
        data={errors}
        keyExtractor={(e) => String(e.id)}
        renderItem={({ item }) => <ErrorRow err={item} />}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Colors[scheme].icon}
          />
        }
      />
    </ThemedView>
  );
}

function ErrorRow({ err }: { err: RunErrorRow }) {
  const scheme = useColorScheme() ?? 'light';
  const statusText = err.http_status != null ? `HTTP ${err.http_status}` : '—';
  return (
    <View style={[styles.errorRow, { borderBottomColor: Colors[scheme].border }]}>
      <View style={styles.errorHeadline}>
        <ThemedText style={[styles.errorPhase, { color: Colors[scheme].danger }]}>{err.phase}</ThemedText>
        <ThemedText style={styles.errorStatus}>{statusText}</ThemedText>
      </View>
      <ThemedText style={styles.errorPath} selectable numberOfLines={3}>
        {err.local_path || '(run-level)'}
      </ThemedText>
      {err.message ? (
        <ThemedText style={styles.errorMsg} selectable>
          {err.message}
        </ThemedText>
      ) : null}
    </View>
  );
}

function Stat({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  const scheme = useColorScheme() ?? 'light';
  return (
    <View style={[styles.stat, { borderColor: Colors[scheme].border }]}>
      <ThemedText
        type="title"
        style={[styles.statValue, bad ? { color: Colors[scheme].danger } : undefined]}>
        {value}
      </ThemedText>
      <ThemedText style={styles.statLabel}>{label}</ThemedText>
    </View>
  );
}

function StatusPill({ status }: { status: RunRow['status'] }) {
  const scheme = useColorScheme() ?? 'light';
  return (
    <View style={[styles.pill, { backgroundColor: statusColor(status, scheme) }]}>
      <ThemedText style={[styles.pillText, { color: Colors[scheme].onAccent }]}>
        {status}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { alignItems: 'center', justifyContent: 'center' },
  header: { padding: 16, gap: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  meta: { opacity: 0.7, fontSize: 13 },
  statsGrid: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  stat: {
    flex: 1,
    padding: 10,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'flex-start',
  },
  statValue: { fontSize: 22, lineHeight: 26 },
  statLabel: { fontSize: 11, opacity: 0.7, marginTop: 2 },
  bytesLine: { opacity: 0.8, marginTop: 4 },
  dedupLine: { fontSize: 13, marginTop: 2 },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginTop: 12,
  },
  retryBtnText: { fontWeight: '700' },
  retryHint: { opacity: 0.6, fontSize: 12, marginTop: 6, fontStyle: 'italic' },
  openJobBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignSelf: 'flex-start',
    marginTop: 8,
  },
  sectionHeader: { marginTop: 16 },
  emptyErrors: { opacity: 0.6, fontStyle: 'italic', marginTop: 4 },
  listContent: { paddingBottom: 24 },
  errorRow: {
    marginHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 3,
  },
  errorHeadline: { flexDirection: 'row', justifyContent: 'space-between' },
  errorPhase: { fontSize: 12, fontWeight: '600' },
  errorStatus: { fontSize: 12, opacity: 0.7 },
  errorPath: { fontSize: 13 },
  errorMsg: { fontSize: 12, opacity: 0.7 },
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  pillText: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase' },
});
