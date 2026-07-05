import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';

import { RunProgress, phaseLabel } from '@/components/run-progress';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { skipReasonLabel, statusColor } from '@/constants/status-colors';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useSyncProgress } from '@/hooks/use-sync-progress';
import { getJob } from '@/src/db/jobs';
import { getLatestRunForJob, listRunErrors, listRunsForJob } from '@/src/db/runs';
import { getServer } from '@/src/db/servers';
import type { JobRow, RunErrorRow, RunRow, ServerRow } from '@/src/db/types';
import { basename, formatBytes } from '@/src/format';
import { requestCancel } from '@/src/sync/run-control';
import { nextPeriodicRunAt } from '@/src/sync/scheduler';
import { ensureNotificationPermission } from '@/src/sync/notify-permission';
import { runJobManual } from '@/src/sync/triggers/manual';

/**
 * Job overview: status first (active progress or last-run result), Sync
 * now, config summary, run history. All settings live behind the header
 * Edit button (`/job/[id]/edit`).
 */
export default function JobOverviewScreen() {
  const { id: idParam } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const db = useSQLiteContext();
  const scheme = useColorScheme() ?? 'light';
  const jobId = Number(idParam);

  const [job, setJob] = useState<JobRow | null>(null);
  const [server, setServer] = useState<ServerRow | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [latestRun, setLatestRun] = useState<RunRow | null>(null);
  const [runHistory, setRunHistory] = useState<RunRow[]>([]);
  const [latestErrors, setLatestErrors] = useState<RunErrorRow[]>([]);
  // `starting` covers the gap between tapping Sync-now and the engine
  // emitting its first progress event; once `progress.activeRun` points at
  // this job the bus takes over as the source of truth.
  const [starting, setStarting] = useState(false);

  const progress = useSyncProgress();
  const activeRunHere =
    progress.activeRun && progress.activeRun.jobId === jobId ? progress.activeRun : null;
  const anyRunActive = progress.activeRun !== null;
  // `cancelling` shows "Cancelling…" after the tap; reset whenever the active
  // run changes (incl. clears) so it doesn't carry over to the next run.
  const [cancelling, setCancelling] = useState(false);
  const activeRunIdHere = activeRunHere?.runId ?? null;
  useEffect(() => {
    setCancelling(false);
  }, [activeRunIdHere]);

  const load = useCallback(async () => {
    if (!Number.isFinite(jobId)) {
      setNotFound(true);
      return;
    }
    const row = await getJob(db, jobId);
    if (!row) {
      setNotFound(true);
      return;
    }
    setJob(row);
    const [srv, latest, runs] = await Promise.all([
      getServer(db, row.server_id),
      getLatestRunForJob(db, jobId),
      listRunsForJob(db, jobId, 10),
    ]);
    setServer(srv);
    setLatestRun(latest);
    setRunHistory(runs);
    setLatestErrors(latest ? await listRunErrors(db, latest.id) : []);
  }, [db, jobId]);

  // Reload on focus: returning from the edit form or a run screen must
  // reflect fresh settings/results.
  useFocusEffect(
    useCallback(() => {
      load().catch((e) => console.warn('job overview load failed', e));
    }, [load]),
  );

  // When the active run for this job ends, pull the final counters.
  useEffect(() => {
    if (!activeRunHere) {
      load().catch(() => {});
    }
  }, [activeRunHere, load]);

  const onSyncNow = async () => {
    if (starting || anyRunActive) return;
    setStarting(true);
    try {
      // First-manual-run notification ask; outcome never gates the run.
      await ensureNotificationPermission().catch(() => {});
      await runJobManual(db, jobId);
    } catch (e) {
      Alert.alert('Sync failed', e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
      load().catch(() => {});
    }
  };

  const onCancel = () => {
    if (!activeRunHere) return;
    setCancelling(true);
    // Cooperative: the engine stops scheduling new files between uploads and
    // finalizes the run as `cancelled`; the bus then clears `activeRun`.
    requestCancel(activeRunHere.runId);
  };

  if (notFound) {
    return (
      <ThemedView style={[styles.container, styles.centered]}>
        <Stack.Screen options={{ title: 'Job' }} />
        <ThemedText type="subtitle">Job not found</ThemedText>
      </ThemedView>
    );
  }
  if (!job) {
    return (
      <ThemedView style={[styles.container, styles.centered]}>
        <Stack.Screen options={{ title: 'Job' }} />
        <ActivityIndicator />
      </ThemedView>
    );
  }

  const needsSource = job.source_kind === 'saf' && job.source_uri === '';
  const syncDisabled = starting || anyRunActive || needsSource;

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen
        options={{
          title: job.name,
          headerRight: () => (
            <Pressable
              onPress={() => router.push(`/job/${jobId}/edit`)}
              hitSlop={8}
              accessibilityLabel="Edit job settings">
              <ThemedText type="defaultSemiBold" style={{ color: Colors[scheme].tint }}>
                Edit
              </ThemedText>
            </Pressable>
          ),
        }}
      />
      <ScrollView contentContainerStyle={styles.scroll}>
        {needsSource ? (
          <Pressable
            onPress={() => router.push(`/job/${jobId}/edit`)}
            style={({ pressed }) => [
              styles.warnCard,
              { borderColor: Colors[scheme].warning, opacity: pressed ? 0.7 : 1 },
            ]}>
            <IconSymbol
              name="exclamationmark.triangle.fill"
              color={Colors[scheme].warning}
              size={18}
            />
            <ThemedText style={{ flex: 1 }}>
              No local folder selected yet — open Edit and pick one.
            </ThemedText>
            <IconSymbol name="chevron.right" color={Colors[scheme].icon} size={16} />
          </Pressable>
        ) : null}

        {activeRunHere ? (
          <View
            style={[
              styles.statusCard,
              {
                borderColor: Colors[scheme].accent,
                backgroundColor: Colors[scheme].accentWash,
              },
            ]}>
            <View style={styles.statusHeader}>
              <IconSymbol
                name="arrow.triangle.2.circlepath"
                color={Colors[scheme].accent}
                size={18}
              />
              <ThemedText type="defaultSemiBold" style={{ flex: 1 }}>
                {phaseLabel(activeRunHere.phase)}
              </ThemedText>
            </View>
            <RunProgress run={activeRunHere} maxFiles={5} />
            <Pressable
              onPress={onCancel}
              disabled={cancelling}
              style={({ pressed }) => [
                styles.cancelBtn,
                {
                  backgroundColor: Colors[scheme].danger,
                  opacity: cancelling ? 0.6 : pressed ? 0.85 : 1,
                },
              ]}>
              <IconSymbol name="xmark.circle.fill" color={Colors[scheme].onAccent} size={20} />
              <ThemedText style={[styles.btnText, { color: Colors[scheme].onAccent }]}>
                {cancelling ? 'Cancelling…' : 'Cancel sync'}
              </ThemedText>
            </Pressable>
          </View>
        ) : (
          <View style={[styles.statusCard, { borderColor: Colors[scheme].border }]}>
            <LastRunSummary run={latestRun} errors={latestErrors} />
            <Pressable
              onPress={onSyncNow}
              disabled={syncDisabled}
              style={({ pressed }) => [
                styles.syncBtn,
                {
                  backgroundColor: syncDisabled ? Colors[scheme].icon : Colors[scheme].accent,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}>
              <IconSymbol
                name="arrow.up.circle.fill"
                color={Colors[scheme].onAccent}
                size={22}
              />
              <ThemedText style={[styles.btnText, { color: Colors[scheme].onAccent }]}>
                {starting ? 'Starting…' : anyRunActive ? 'Another sync is running' : 'Sync now'}
              </ThemedText>
            </Pressable>
          </View>
        )}

        <Pressable
          onPress={() => router.push(`/job/${jobId}/edit`)}
          style={({ pressed }) => [
            styles.summaryCard,
            { borderColor: Colors[scheme].border, opacity: pressed ? 0.7 : 1 },
          ]}
          accessibilityLabel="Job configuration — tap to edit">
          <SummaryRow
            icon={job.source_kind === 'media' ? 'photo.on.rectangle' : 'folder.fill'}
            label={
              job.source_kind === 'media'
                ? 'Camera roll'
                : decodeURIComponent(basename(job.source_uri)) || 'Folder'
            }
          />
          <SummaryRow
            icon="arrow.up.circle.fill"
            label={`${server?.name ?? '(missing server)'} → ${job.remote_path}`}
          />
          <SummaryRow
            icon="clock"
            label={scheduleSummary(job, latestRun?.started_at ?? null)}
          />
        </Pressable>

        <ThemedText type="subtitle" style={styles.sectionHeader}>
          Recent runs
        </ThemedText>
        {runHistory.length === 0 ? (
          <ThemedText style={styles.emptyHint}>No runs yet.</ThemedText>
        ) : (
          runHistory.map((r) => (
            <Pressable
              key={r.id}
              onPress={() => router.push(`/run/${r.id}`)}
              style={({ pressed }) => [
                styles.runRow,
                { borderBottomColor: Colors[scheme].border, opacity: pressed ? 0.6 : 1 },
              ]}>
              <View
                style={[styles.statusDot, { backgroundColor: statusColor(r.status, scheme) }]}
              />
              <View style={{ flex: 1, gap: 2 }}>
                <ThemedText style={styles.runTitle}>
                  {new Date(r.started_at).toLocaleString()} · {r.status}
                </ThemedText>
                <ThemedText style={styles.runSub}>
                  {r.status === 'skipped' && r.skip_reason
                    ? skipReasonLabel(r.skip_reason)
                    : `${r.files_uploaded} uploaded · ${r.files_skipped} skipped · ${r.files_failed} failed`}
                </ThemedText>
              </View>
              <IconSymbol name="chevron.right" color={Colors[scheme].icon} size={16} />
            </Pressable>
          ))
        )}
      </ScrollView>
    </ThemedView>
  );
}

function LastRunSummary({ run, errors }: { run: RunRow | null; errors: RunErrorRow[] }) {
  const scheme = useColorScheme() ?? 'light';
  if (!run) {
    return (
      <ThemedText style={styles.emptyHint}>
        Never synced — tap Sync now to run the first backup.
      </ThemedText>
    );
  }
  return (
    <View style={{ gap: 4 }}>
      <View style={styles.runLine}>
        <View
          style={[styles.statusDot, { backgroundColor: statusColor(run.status, scheme) }]}
        />
        <ThemedText type="defaultSemiBold">{run.status}</ThemedText>
        <ThemedText style={styles.muted}>
          · {new Date(run.started_at).toLocaleString()}
        </ThemedText>
      </View>
      {run.status === 'skipped' && run.skip_reason ? (
        <ThemedText style={styles.muted}>
          Skipped: {skipReasonLabel(run.skip_reason)}
        </ThemedText>
      ) : null}
      <ThemedText style={styles.muted}>
        {run.files_scanned} scanned, {run.files_uploaded} uploaded,{' '}
        {run.files_skipped} skipped, {run.files_failed} failed (
        {formatBytes(run.bytes_uploaded)})
      </ThemedText>
      {errors.length > 0 ? (
        <View style={{ marginTop: 4, gap: 2 }}>
          <ThemedText
            style={[styles.errorHeader, { color: Colors[scheme].danger }]}>
            {errors.length} error{errors.length === 1 ? '' : 's'}:
          </ThemedText>
          {errors.slice(0, 3).map((e) => (
            <ThemedText
              key={e.id}
              style={[styles.errorText, { color: Colors[scheme].danger }]}
              numberOfLines={1}>
              {e.phase}: {basename(e.local_path) || '(run)'} —{' '}
              {e.message ?? `HTTP ${e.http_status}`}
            </ThemedText>
          ))}
          {errors.length > 3 ? (
            <ThemedText style={styles.muted}>…and {errors.length - 3} more</ThemedText>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function SummaryRow({
  icon,
  label,
}: {
  icon: React.ComponentProps<typeof IconSymbol>['name'];
  label: string;
}) {
  const scheme = useColorScheme() ?? 'light';
  return (
    <View style={styles.summaryRow}>
      <IconSymbol name={icon} color={Colors[scheme].icon} size={16} />
      <ThemedText style={styles.summaryText} numberOfLines={1}>
        {label}
      </ThemedText>
    </View>
  );
}

function scheduleSummary(job: JobRow, lastRunStartedAt: number | null): string {
  if (job.periodic_enabled !== 1) return 'Manual sync only';
  const constraints = [
    job.wifi_only === 1 ? 'Wi-Fi only' : null,
    job.charging_only === 1 ? 'charging only' : null,
  ].filter(Boolean);
  const base = `Every ${job.periodic_minutes} min${
    constraints.length ? ` · ${constraints.join(' · ')}` : ''
  }`;
  const nextAt = nextPeriodicRunAt(
    { periodic_enabled: 1, periodic_minutes: job.periodic_minutes },
    lastRunStartedAt,
    Date.now(),
  );
  if (nextAt === null) return base;
  const diffMin = Math.max(0, Math.round((nextAt - Date.now()) / 60_000));
  return `${base} · next in ${diffMin}m`;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: 16, paddingBottom: 32, gap: 12 },
  warnCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  statusCard: {
    padding: 14,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  statusHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  syncBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 8,
  },
  cancelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 8,
  },
  btnText: { fontWeight: '600', fontSize: 16 },
  summaryCard: {
    padding: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  summaryRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  summaryText: { flex: 1, fontSize: 14 },
  sectionHeader: { marginTop: 4 },
  emptyHint: { opacity: 0.7 },
  runRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  runTitle: { fontSize: 14 },
  runSub: { fontSize: 13, opacity: 0.7 },
  runLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  muted: { opacity: 0.7, fontSize: 13 },
  errorHeader: { fontSize: 13, fontWeight: '600' },
  errorText: { fontSize: 12 },
});
