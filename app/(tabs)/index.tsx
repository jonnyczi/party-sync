import { useFocusEffect, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RunProgress, phaseLabel } from '@/components/run-progress';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { statusColor } from '@/constants/status-colors';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useSyncAll } from '@/hooks/use-sync-all';
import { useSyncProgress } from '@/hooks/use-sync-progress';
import { listJobs } from '@/src/db/jobs';
import {
  getLatestRunForJob,
  listRecentErrors,
  listRunsSince,
  type RecentErrorRow,
} from '@/src/db/runs';
import { listServers } from '@/src/db/servers';
import type { JobRow, RunRow, ServerRow } from '@/src/db/types';
import { basename, formatBytes, formatRelativeTime } from '@/src/format';
import { requestCancel } from '@/src/sync/run-control';
import {
  aggregateRuns,
  bucketBytesByDay,
  type DayBucket,
} from '@/src/sync/aggregates';
import type { ActiveRunSnapshot } from '@/src/sync/progress';

const DAYS_WINDOW = 7;
const STATS_WINDOW_MS = 24 * 60 * 60 * 1000;
const HISTORY_WINDOW_MS = DAYS_WINDOW * 24 * 60 * 60 * 1000;

export default function HomeScreen() {
  const db = useSQLiteContext();
  const router = useRouter();
  const scheme = useColorScheme() ?? 'light';
  const insets = useSafeAreaInsets();
  const progress = useSyncProgress();
  const activeRun = progress.activeRun;
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [latestByJob, setLatestByJob] = useState<Map<number, RunRow | null>>(
    new Map(),
  );
  const [recentErrors, setRecentErrors] = useState<RecentErrorRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    const now = Date.now();
    const [js, ss, rs, es] = await Promise.all([
      listJobs(db),
      listServers(db),
      listRunsSince(db, now - HISTORY_WINDOW_MS),
      listRecentErrors(db, 10),
    ]);
    // The health strip needs each job's true latest run, which can be older
    // than the 7-day window `runs` covers.
    const latest = new Map<number, RunRow | null>();
    await Promise.all(
      js.map(async (j) => {
        latest.set(j.id, await getLatestRunForJob(db, j.id));
      }),
    );
    setJobs(js);
    setServers(ss);
    setRuns(rs);
    setLatestByJob(latest);
    setRecentErrors(es);
  }, [db]);

  useFocusEffect(
    useCallback(() => {
      refresh().catch((e) => console.warn('dashboard refresh failed', e));
    }, [refresh]),
  );

  // Re-pull the moment a run finishes so stats/errors don't lag a focus event.
  const prevActive = useRef<ActiveRunSnapshot | null>(null);
  useEffect(() => {
    if (prevActive.current && !activeRun) {
      refresh().catch((e) => console.warn('dashboard refresh failed', e));
    }
    prevActive.current = activeRun;
  }, [activeRun, refresh]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    refresh()
      .catch((e) => console.warn('dashboard refresh failed', e))
      .finally(() => setRefreshing(false));
  }, [refresh]);

  const jobsById = new Map<number, JobRow>(jobs.map((j) => [j.id, j]));
  const now = Date.now();
  const recentRuns = runs.filter((r) => r.started_at >= now - STATS_WINDOW_MS);
  const stats = aggregateRuns(recentRuns);
  const buckets = bucketBytesByDay(runs, DAYS_WINDOW, now);
  const hasAnyRuns = runs.length > 0;
  const hasAnyBytes = runs.some((r) => r.bytes_uploaded > 0);
  const lastRun = runs[0] ?? null;
  const lastRunJob = lastRun ? jobsById.get(lastRun.job_id) ?? null : null;

  const isFresh = servers.length === 0 && jobs.length === 0;

  return (
    <ThemedView style={[styles.container, { paddingTop: insets.top + 8 }]}>
      <View style={styles.header}>
        <ThemedText type="title">Dashboard</ThemedText>
        <Pressable
          onPress={() => router.push('/settings')}
          hitSlop={8}
          accessibilityLabel="Open settings"
          style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}>
          <IconSymbol name="gearshape.fill" color={Colors[scheme].icon} size={24} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Colors[scheme].icon}
          />
        }>
        {isFresh ? (
          <OnboardingCard
            onAddServer={() => router.push('/(tabs)/servers')}
            onAddJob={() => router.push('/(tabs)/jobs')}
            hasServers={false}
          />
        ) : null}

        {!isFresh && activeRun ? (
          <ActiveRunCard
            run={activeRun}
            jobName={jobsById.get(activeRun.jobId)?.name ?? 'Syncing'}
            onOpen={() => router.push(`/job/${activeRun.jobId}`)}
          />
        ) : null}

        {!isFresh && !activeRun && lastRun ? (
          <LastRunCard
            run={lastRun}
            jobName={lastRunJob?.name ?? '(deleted job)'}
            onOpen={() => router.push(`/run/${lastRun.id}`)}
          />
        ) : null}

        {!isFresh && !activeRun && !lastRun && jobs.length > 0 ? (
          <IdleNoRunsCard onOpenJobs={() => router.push('/(tabs)/jobs')} />
        ) : null}

        {hasAnyRuns ? (
          <View style={styles.summary}>
            <SummaryCell label="Uploaded / 24h" value={String(stats.uploaded)} />
            <SummaryCell
              label="Failed / 24h"
              value={String(stats.failed)}
              bad={stats.failed > 0}
            />
            <SummaryCell label="Bytes / 24h" value={formatBytes(stats.bytes)} />
          </View>
        ) : null}

        {hasAnyBytes ? <BytesOverTime buckets={buckets} /> : null}

        {jobs.length > 0 ? (
          <HealthStrip
            jobs={jobs}
            latestByJob={latestByJob}
            onOpen={() => router.push('/(tabs)/jobs')}
          />
        ) : null}

        {recentErrors.length > 0 ? (
          <>
            <ThemedText type="subtitle" style={styles.sectionHeader}>
              Recent errors
            </ThemedText>
            {recentErrors.map((err) => (
              <Pressable
                key={err.error_id}
                onPress={() => router.push(`/run/${err.run_id}`)}
                style={({ pressed }) => [
                  styles.errorRow,
                  { borderBottomColor: Colors[scheme].border, opacity: pressed ? 0.6 : 1 },
                ]}>
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={styles.errorHeadline}>
                    <ThemedText style={[styles.errorPhase, { color: Colors[scheme].danger }]}>
                      {err.phase}
                    </ThemedText>
                    <ThemedText style={styles.errorStatus}>
                      {err.http_status != null ? `HTTP ${err.http_status}` : '—'}
                    </ThemedText>
                  </View>
                  <ThemedText numberOfLines={1} style={styles.errorPath}>
                    {err.job_name} · {basename(err.local_path) || '(run)'}
                  </ThemedText>
                  {err.message ? (
                    <ThemedText numberOfLines={1} style={styles.errorMsg}>
                      {err.message}
                    </ThemedText>
                  ) : null}
                </View>
                <IconSymbol name="chevron.right" color={Colors[scheme].icon} size={16} />
              </Pressable>
            ))}
          </>
        ) : null}

        {!isFresh && jobs.length === 0 ? (
          <OnboardingCard
            onAddServer={() => router.push('/(tabs)/servers')}
            onAddJob={() => router.push('/(tabs)/jobs')}
            hasServers={servers.length > 0}
          />
        ) : null}
      </ScrollView>
    </ThemedView>
  );
}

function ActiveRunCard({
  run,
  jobName,
  onOpen,
}: {
  run: ActiveRunSnapshot;
  jobName: string;
  onOpen: () => void;
}) {
  const scheme = useColorScheme() ?? 'light';
  const { batch } = useSyncAll();
  const phase = batch
    ? `job ${Math.min(batch.completed + 1, batch.total)}/${batch.total} · ${phaseLabel(run.phase)}`
    : phaseLabel(run.phase);
  const onCancelPress = () => {
    Alert.alert(
      'Cancel sync?',
      'Stop the current sync run. Files already uploaded are kept; the rest resume next time.',
      [
        { text: 'Keep syncing', style: 'cancel' },
        {
          text: 'Cancel sync',
          style: 'destructive',
          onPress: () => requestCancel(run.runId),
        },
      ],
    );
  };
  return (
    <Pressable
      onPress={onOpen}
      style={({ pressed }) => [
        styles.hero,
        {
          borderColor: Colors[scheme].accent,
          backgroundColor: Colors[scheme].accentWash,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
      accessibilityLabel="Open active sync job">
      <View style={styles.heroHeader}>
        <IconSymbol name="arrow.triangle.2.circlepath" color={Colors[scheme].accent} size={18} />
        <ThemedText type="defaultSemiBold" style={{ flex: 1 }} numberOfLines={1}>
          {jobName}
        </ThemedText>
        <ThemedText style={styles.heroPhase}>{phase}</ThemedText>
      </View>
      <RunProgress run={run} />
      <Pressable
        onPress={onCancelPress}
        hitSlop={8}
        style={({ pressed }) => [styles.heroCancel, { opacity: pressed ? 0.6 : 1 }]}
        accessibilityLabel="Cancel sync">
        <IconSymbol name="xmark.circle.fill" color={Colors[scheme].danger} size={16} />
        <ThemedText style={[styles.heroCancelText, { color: Colors[scheme].danger }]}>
          Cancel
        </ThemedText>
      </Pressable>
    </Pressable>
  );
}

function LastRunCard({
  run,
  jobName,
  onOpen,
}: {
  run: RunRow;
  jobName: string;
  onOpen: () => void;
}) {
  const scheme = useColorScheme() ?? 'light';
  return (
    <Pressable
      onPress={onOpen}
      style={({ pressed }) => [
        styles.hero,
        { borderColor: Colors[scheme].border, opacity: pressed ? 0.7 : 1 },
      ]}>
      <View style={styles.heroHeader}>
        <StatusDot status={run.status} />
        <ThemedText type="defaultSemiBold" style={{ flex: 1 }} numberOfLines={1}>
          {jobName}
        </ThemedText>
        <ThemedText style={styles.heroPhase}>{run.status}</ThemedText>
      </View>
      <ThemedText style={styles.heroMuted}>
        {new Date(run.started_at).toLocaleString()}
      </ThemedText>
      <ThemedText style={styles.heroMuted}>
        {run.files_uploaded} uploaded · {run.files_skipped} skipped ·{' '}
        {run.files_failed} failed · {formatBytes(run.bytes_uploaded)}
      </ThemedText>
      <ThemedText style={[styles.heroMuted, { color: Colors[scheme].accent }]}>
        Tap to open →
      </ThemedText>
    </Pressable>
  );
}

function IdleNoRunsCard({ onOpenJobs }: { onOpenJobs: () => void }) {
  const scheme = useColorScheme() ?? 'light';
  return (
    <Pressable
      onPress={onOpenJobs}
      style={({ pressed }) => [
        styles.hero,
        { borderColor: Colors[scheme].border, opacity: pressed ? 0.7 : 1 },
      ]}>
      <ThemedText type="defaultSemiBold">No runs yet</ThemedText>
      <ThemedText style={styles.heroMuted}>
        Open a job from the Jobs tab and tap Sync now.
      </ThemedText>
    </Pressable>
  );
}

function OnboardingCard({
  onAddServer,
  onAddJob,
  hasServers,
}: {
  onAddServer: () => void;
  onAddJob: () => void;
  hasServers: boolean;
}) {
  const scheme = useColorScheme() ?? 'light';
  return (
    <View style={[styles.onboarding, { borderColor: Colors[scheme].border }]}>
      <ThemedText type="subtitle">Get started</ThemedText>
      <OnboardingStep
        n={1}
        label="Add a copyparty server"
        done={hasServers}
        onPress={onAddServer}
      />
      <OnboardingStep
        n={2}
        label="Create a sync job"
        done={false}
        onPress={onAddJob}
      />
    </View>
  );
}

function OnboardingStep({
  n,
  label,
  done,
  onPress,
}: {
  n: number;
  label: string;
  done: boolean;
  onPress: () => void;
}) {
  const scheme = useColorScheme() ?? 'light';
  const tint = Colors[scheme].tint;
  const success = Colors[scheme].success;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.onboardingStep,
        { borderColor: tint, opacity: pressed ? 0.7 : 1 },
      ]}>
      <View
        style={[
          styles.onboardingBadge,
          done
            ? { backgroundColor: success, borderColor: success }
            : { borderColor: tint },
        ]}>
        {done ? (
          <IconSymbol name="checkmark.circle.fill" color={Colors[scheme].onAccent} size={16} />
        ) : (
          <ThemedText style={{ color: tint, fontWeight: '700' }}>{n}</ThemedText>
        )}
      </View>
      <ThemedText style={{ flex: 1 }}>{label}</ThemedText>
      <IconSymbol name="chevron.right" color={tint} size={18} />
    </Pressable>
  );
}

function BytesOverTime({ buckets }: { buckets: DayBucket[] }) {
  const scheme = useColorScheme() ?? 'light';
  const tint = Colors[scheme].tint;
  const peak = buckets.reduce((m, b) => (b.bytes > m ? b.bytes : m), 0);
  return (
    <View style={[styles.chartWrap, { borderColor: Colors[scheme].border }]}>
      <View style={styles.chartHeader}>
        <ThemedText type="subtitle">Last {buckets.length} days</ThemedText>
        <ThemedText style={styles.chartPeak}>
          peak {formatBytes(peak)}
        </ThemedText>
      </View>
      <View style={styles.chart}>
        {buckets.map((b, i) => {
          const last = i === buckets.length - 1;
          const pct = peak > 0 ? Math.max(2, Math.round((b.bytes / peak) * 100)) : 2;
          return (
            <View key={b.day} style={styles.chartCol}>
              <View style={styles.chartTrack}>
                <View
                  style={[
                    styles.chartBar,
                    {
                      height: `${pct}%`,
                      backgroundColor: last ? tint : Colors[scheme].muted,
                      opacity: b.bytes > 0 ? (last ? 1 : 0.6) : 0.25,
                    },
                  ]}
                />
              </View>
              <ThemedText style={styles.chartLabel}>{dayLabel(b.day, last)}</ThemedText>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function HealthStrip({
  jobs,
  latestByJob,
  onOpen,
}: {
  jobs: JobRow[];
  latestByJob: Map<number, RunRow | null>;
  onOpen: () => void;
}) {
  const scheme = useColorScheme() ?? 'light';
  const latest = jobs.map((j) => latestByJob.get(j.id) ?? null);
  const failing = latest.filter((r) => r?.status === 'failed').length;
  const partial = latest.filter((r) => r?.status === 'partial').length;
  const never = latest.filter((r) => r === null).length;
  const lastSyncAt = latest.reduce(
    (m, r) => (r && r.started_at > m ? r.started_at : m),
    0,
  );

  const color =
    failing > 0
      ? Colors[scheme].danger
      : partial > 0
        ? Colors[scheme].warning
        : never === jobs.length
          ? Colors[scheme].muted
          : Colors[scheme].success;

  const parts = [`${jobs.length} job${jobs.length === 1 ? '' : 's'}`];
  if (failing > 0) parts.push(`${failing} failing`);
  if (partial > 0) parts.push(`${partial} partial`);
  if (never > 0) parts.push(`${never} never synced`);
  if (failing === 0 && partial === 0 && never === 0) parts.push('all ok');
  if (lastSyncAt > 0) parts.push(`last sync ${formatRelativeTime(lastSyncAt)}`);

  return (
    <Pressable
      onPress={onOpen}
      accessibilityLabel="Open the Jobs tab"
      style={({ pressed }) => [
        styles.healthStrip,
        { borderColor: Colors[scheme].border, opacity: pressed ? 0.6 : 1 },
      ]}>
      <View style={[styles.statusDot, { backgroundColor: color }]} />
      <ThemedText style={styles.healthText} numberOfLines={1}>
        {parts.join(' · ')}
      </ThemedText>
      <IconSymbol name="chevron.right" color={Colors[scheme].icon} size={16} />
    </Pressable>
  );
}

function StatusDot({ status }: { status: RunRow['status'] }) {
  const scheme = useColorScheme() ?? 'light';
  return <View style={[styles.statusDot, { backgroundColor: statusColor(status, scheme) }]} />;
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
  const scheme = useColorScheme() ?? 'light';
  return (
    <View style={[styles.summaryCell, { borderColor: Colors[scheme].border }]}>
      <ThemedText
        type="title"
        style={[styles.summaryValue, bad ? { color: Colors[scheme].danger } : undefined]}>
        {value}
      </ThemedText>
      <ThemedText style={styles.summaryLabel}>{label}</ThemedText>
    </View>
  );
}

function dayLabel(day: string, isToday: boolean): string {
  if (isToday) return 'Today';
  const d = new Date(day + 'T00:00:00');
  return d.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 3);
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
  scroll: { paddingBottom: 24 },
  hero: {
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    gap: 6,
  },
  heroHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  heroPhase: { fontSize: 12, opacity: 0.7, textTransform: 'capitalize' },
  heroMuted: { fontSize: 12, opacity: 0.7 },
  heroCancel: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    marginTop: 8,
    paddingVertical: 4,
  },
  heroCancelText: { fontSize: 13, fontWeight: '600' },
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
    alignItems: 'flex-start',
  },
  summaryValue: { fontSize: 20, lineHeight: 24 },
  summaryLabel: { fontSize: 11, opacity: 0.7, marginTop: 2 },
  sectionHeader: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  healthStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 16,
    marginBottom: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  healthText: { flex: 1, fontSize: 14 },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  errorHeadline: { flexDirection: 'row', justifyContent: 'space-between' },
  errorPhase: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase' },
  errorStatus: { fontSize: 11, opacity: 0.7 },
  errorPath: { fontSize: 13 },
  errorMsg: { fontSize: 12, opacity: 0.7 },
  onboarding: {
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 14,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  onboardingStep: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  onboardingBadge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chartWrap: {
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  chartHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  chartPeak: { fontSize: 11, opacity: 0.7 },
  chart: { flexDirection: 'row', alignItems: 'flex-end', height: 72, gap: 4 },
  chartCol: { flex: 1, alignItems: 'center', gap: 4 },
  chartTrack: {
    width: '100%',
    height: 56,
    justifyContent: 'flex-end',
    alignItems: 'stretch',
  },
  chartBar: { width: '100%', borderRadius: 3, minHeight: 2 },
  chartLabel: { fontSize: 10, opacity: 0.7 },
});
