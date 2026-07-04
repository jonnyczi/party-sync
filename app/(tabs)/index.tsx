import { useFocusEffect, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { statusColor } from '@/constants/status-colors';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { formatEta, formatRate, useEta } from '@/hooks/use-eta';
import { useSyncProgress } from '@/hooks/use-sync-progress';
import { listJobs } from '@/src/db/jobs';
import {
  listRecentErrors,
  listRunsSince,
  type RecentErrorRow,
} from '@/src/db/runs';
import { listServers } from '@/src/db/servers';
import type { JobRow, RunRow, ServerRow } from '@/src/db/types';
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
  const progress = useSyncProgress();
  const activeRun = progress.activeRun;
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
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
    setJobs(js);
    setServers(ss);
    setRuns(rs);
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
    <ThemedView style={styles.container}>
      <View style={styles.header}>
        <ThemedText type="title">Dashboard</ThemedText>
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
            onAddServer={() => router.push('/(tabs)/settings')}
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

        {hasAnyBytes ? <BytesOverTime buckets={buckets} tint={Colors[scheme].tint} /> : null}

        {jobs.length > 0 ? (
          <>
            <ThemedText type="subtitle" style={styles.sectionHeader}>
              Jobs
            </ThemedText>
            {jobs.map((job) => {
              const run = runs.find((r) => r.job_id === job.id) ?? null;
              return (
                <Pressable
                  key={job.id}
                  onPress={() => router.push(`/job/${job.id}`)}
                  style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}>
                  <View style={{ flex: 1, gap: 3 }}>
                    <ThemedText type="defaultSemiBold">{job.name}</ThemedText>
                    <ThemedText style={styles.rowSub} numberOfLines={1}>
                      {job.remote_path}
                    </ThemedText>
                    <RunLine run={run} />
                  </View>
                  <IconSymbol name="chevron.right" color={Colors[scheme].icon} size={18} />
                </Pressable>
              );
            })}
          </>
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
                  { opacity: pressed ? 0.6 : 1 },
                ]}>
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={styles.errorHeadline}>
                    <ThemedText style={styles.errorPhase}>{err.phase}</ThemedText>
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
            onAddServer={() => router.push('/(tabs)/settings')}
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
  const { etaMs, rateBytesPerSec } = useEta(
    run.uploadedBytes,
    run.totalBytes,
    run.startedAt,
  );
  const pct =
    run.totalBytes > 0
      ? Math.min(100, Math.round((run.uploadedBytes / run.totalBytes) * 100))
      : 0;
  const label =
    run.phase === 'scanning'
      ? 'Scanning…'
      : run.phase === 'finalizing'
        ? 'Finalizing…'
        : 'Uploading';
  const eta = formatEta(etaMs);
  const rate = formatRate(rateBytesPerSec);
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
        <ThemedText style={styles.heroPhase}>{label}</ThemedText>
      </View>
      <View style={styles.progressTrack}>
        <View
          style={[
            styles.progressFill,
            { width: `${pct}%`, backgroundColor: Colors[scheme].accent },
          ]}
        />
      </View>
      <View style={styles.heroProgressRow}>
        <ThemedText style={styles.heroMuted}>
          {formatBytes(run.uploadedBytes)} / {formatBytes(run.totalBytes)} ({pct}%)
        </ThemedText>
        <ThemedText style={styles.heroMuted}>
          {[rate, eta].filter(Boolean).join(' · ')}
        </ThemedText>
      </View>
      {run.activeFiles.length > 0 ? (
        <View style={styles.heroFiles}>
          {run.activeFiles.slice(0, 4).map((f) => {
            const fpct =
              f.size > 0
                ? Math.min(100, Math.round((f.bytesUploaded / f.size) * 100))
                : 0;
            return (
              <View key={f.localPath} style={styles.heroFileRow}>
                <ThemedText numberOfLines={1} style={styles.heroFileName}>
                  {f.name}
                </ThemedText>
                <ThemedText style={styles.heroFilePct}>{fpct}%</ThemedText>
              </View>
            );
          })}
          {run.activeFiles.length > 4 ? (
            <ThemedText style={styles.heroMuted}>
              +{run.activeFiles.length - 4} more uploading…
            </ThemedText>
          ) : null}
        </View>
      ) : null}
      <ThemedText style={styles.heroMuted}>
        {run.counters.uploaded} uploaded · {run.counters.skipped} skipped ·{' '}
        {run.counters.failed} failed
      </ThemedText>
      {run.dedupedBytes > 0 ? (
        <ThemedText style={[styles.heroDedup, { color: Colors[scheme].success }]}>
          saved {formatBytes(run.dedupedBytes)} via dedup
        </ThemedText>
      ) : null}
      {run.errors.length > 0 ? (
        <View style={{ marginTop: 4, gap: 2 }}>
          {run.errors.slice(-3).map((e, i) => (
            <ThemedText key={i} style={[styles.heroError, { color: Colors[scheme].danger }]} numberOfLines={1}>
              {e.phase}: {basename(e.localPath) || '(run)'} —{' '}
              {e.message ?? `HTTP ${e.httpStatus}`}
            </ThemedText>
          ))}
        </View>
      ) : null}
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
    <View style={styles.onboarding}>
      <ThemedText type="subtitle">Get started</ThemedText>
      <OnboardingStep
        n={1}
        label="Add a copyparty server"
        done={hasServers}
        onPress={onAddServer}
        tint={Colors[scheme].tint}
      />
      <OnboardingStep
        n={2}
        label="Create a sync job"
        done={false}
        onPress={onAddJob}
        tint={Colors[scheme].tint}
      />
    </View>
  );
}

function OnboardingStep({
  n,
  label,
  done,
  onPress,
  tint,
}: {
  n: number;
  label: string;
  done: boolean;
  onPress: () => void;
  tint: string;
}) {
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
            ? { backgroundColor: '#2a9d3f', borderColor: '#2a9d3f' }
            : { borderColor: tint },
        ]}>
        {done ? (
          <IconSymbol name="checkmark.circle.fill" color="#fff" size={16} />
        ) : (
          <ThemedText style={{ color: tint, fontWeight: '700' }}>{n}</ThemedText>
        )}
      </View>
      <ThemedText style={{ flex: 1 }}>{label}</ThemedText>
      <IconSymbol name="chevron.right" color={tint} size={18} />
    </Pressable>
  );
}

function BytesOverTime({ buckets, tint }: { buckets: DayBucket[]; tint: string }) {
  const peak = buckets.reduce((m, b) => (b.bytes > m ? b.bytes : m), 0);
  return (
    <View style={styles.chartWrap}>
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
                      backgroundColor: last ? tint : '#8886',
                      opacity: b.bytes > 0 ? 1 : 0.3,
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

function RunLine({ run }: { run: RunRow | null }) {
  if (!run) {
    return <ThemedText style={styles.runMuted}>Never synced</ThemedText>;
  }
  return (
    <View style={styles.runLine}>
      <StatusDot status={run.status} />
      <ThemedText style={styles.runText} numberOfLines={1}>
        {new Date(run.started_at).toLocaleString()} · {run.status}
      </ThemedText>
    </View>
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
    <View style={styles.summaryCell}>
      <ThemedText
        type="title"
        style={[styles.summaryValue, bad ? { color: Colors[scheme].danger } : undefined]}>
        {value}
      </ThemedText>
      <ThemedText style={styles.summaryLabel}>{label}</ThemedText>
    </View>
  );
}

function basename(p: string): string {
  if (!p) return '';
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function dayLabel(day: string, isToday: boolean): string {
  if (isToday) return 'Today';
  const d = new Date(day + 'T00:00:00');
  return d.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 3);
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 56 },
  header: { paddingHorizontal: 16, paddingBottom: 12 },
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
  heroProgressRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  heroFiles: { marginTop: 2, gap: 2 },
  heroFileRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  heroFileName: { flex: 1, fontSize: 12, opacity: 0.85 },
  heroFilePct: { fontSize: 12, opacity: 0.7, fontVariant: ['tabular-nums'] },
  heroDedup: { fontSize: 12, color: '#2a9d3f' },
  heroError: { fontSize: 11, color: '#c33' },
  heroCancel: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    marginTop: 8,
    paddingVertical: 4,
  },
  heroCancelText: { fontSize: 13, fontWeight: '600' },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: '#8883',
    overflow: 'hidden',
  },
  progressFill: { height: '100%' },
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
  summaryValue: { fontSize: 20, lineHeight: 24 },
  summaryLabel: { fontSize: 11, opacity: 0.7, marginTop: 2 },
  sectionHeader: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
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
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#8882',
  },
  errorHeadline: { flexDirection: 'row', justifyContent: 'space-between' },
  errorPhase: { fontSize: 12, fontWeight: '600', color: '#c33', textTransform: 'uppercase' },
  errorStatus: { fontSize: 11, opacity: 0.7 },
  errorPath: { fontSize: 13 },
  errorMsg: { fontSize: 11, opacity: 0.7 },
  onboarding: {
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 14,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#8884',
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
    borderColor: '#8884',
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
