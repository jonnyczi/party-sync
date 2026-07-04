import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { getJob } from '@/src/db/jobs';
import { getRun, listRunErrors } from '@/src/db/runs';
import { getServer } from '@/src/db/servers';
import type {
  JobRow,
  RunErrorRow,
  RunRow,
  ServerRow,
} from '@/src/db/types';

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

  useEffect(() => {
    if (!Number.isFinite(runId)) {
      setNotFound(true);
      return;
    }
    let cancelled = false;
    (async () => {
      const run = await getRun(db, runId);
      if (!run) {
        if (!cancelled) setNotFound(true);
        return;
      }
      const [job, errors] = await Promise.all([
        getJob(db, run.job_id),
        listRunErrors(db, run.id),
      ]);
      if (!job) {
        if (!cancelled) setNotFound(true);
        return;
      }
      const server = await getServer(db, job.server_id);
      if (!cancelled) setData({ run, job, server, errors });
    })();
    return () => {
      cancelled = true;
    };
  }, [db, runId]);

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
              <ThemedText style={styles.dedupLine}>
                {formatBytes(run.bytes_deduped)} saved via dedup
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
      />
    </ThemedView>
  );
}

function ErrorRow({ err }: { err: RunErrorRow }) {
  const statusText = err.http_status != null ? `HTTP ${err.http_status}` : '—';
  return (
    <View style={styles.errorRow}>
      <View style={styles.errorHeadline}>
        <ThemedText style={styles.errorPhase}>{err.phase}</ThemedText>
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
  return (
    <View style={styles.stat}>
      <ThemedText
        type="title"
        style={[styles.statValue, bad ? { color: '#c33' } : undefined]}>
        {value}
      </ThemedText>
      <ThemedText style={styles.statLabel}>{label}</ThemedText>
    </View>
  );
}

function StatusPill({ status }: { status: RunRow['status'] }) {
  const bg =
    status === 'ok'
      ? '#2a9d3f'
      : status === 'partial'
        ? '#d08900'
        : status === 'failed'
          ? '#c33'
          : '#888';
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <ThemedText style={styles.pillText}>{status}</ThemedText>
    </View>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
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
    borderColor: '#8884',
    alignItems: 'flex-start',
  },
  statValue: { fontSize: 22, lineHeight: 26 },
  statLabel: { fontSize: 11, opacity: 0.7, marginTop: 2 },
  bytesLine: { opacity: 0.8, marginTop: 4 },
  dedupLine: { color: '#2a9d3f', fontSize: 13, marginTop: 2 },
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
    borderBottomColor: '#8882',
    gap: 3,
  },
  errorHeadline: { flexDirection: 'row', justifyContent: 'space-between' },
  errorPhase: { fontSize: 12, fontWeight: '600', color: '#c33' },
  errorStatus: { fontSize: 12, opacity: 0.7 },
  errorPath: { fontSize: 13 },
  errorMsg: { fontSize: 12, opacity: 0.7 },
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  pillText: { color: '#fff', fontSize: 12, fontWeight: '600', textTransform: 'uppercase' },
});
