import * as FileSystem from 'expo-file-system/legacy';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  View,
} from 'react-native';

import { RemotePathBrowser } from '@/components/remote-path-browser';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { formatEta, formatRate, useEta } from '@/hooks/use-eta';
import { useSyncProgress } from '@/hooks/use-sync-progress';
import { normalizeRemotePath } from '@/src/copyparty/paths';
import { testJobConnection } from '@/src/copyparty/test-connection';
import {
  createJob,
  DEFAULT_CONCURRENCY,
  deleteJob,
  getJob,
  MAX_CONCURRENCY,
  MIN_CONCURRENCY,
  updateJob,
} from '@/src/db/jobs';
import {
  getLatestRunForJob,
  listRunErrors,
  listRunsForJob,
} from '@/src/db/runs';
import { listServers } from '@/src/db/servers';
import type {
  PathOrganization,
  RunErrorRow,
  RunRow,
  ServerRow,
  SourceKind,
} from '@/src/db/types';
import { getServerPassword } from '@/src/storage/secrets';
import { ensureNotificationPermission } from '@/src/sync/notify-permission';
import { dateSubdir, PATH_ORGANIZATIONS } from '@/src/sync/path-organization';
import type { ActiveRunSnapshot } from '@/src/sync/progress';
import {
  nextPeriodicRunAt,
  PERIODIC_MIN_INTERVAL_MIN,
} from '@/src/sync/scheduler';
import { syncPeriodicRegistration } from '@/src/sync/scheduler-register';
import { runJobManual } from '@/src/sync/triggers/manual';
import { MEDIA_SOURCE_ALL } from '@/src/sync/walker/media';

const PATH_ORG_LABELS: Record<PathOrganization, string> = {
  flat: 'None (flat)',
  year: 'By year',
  year_month: 'By year / month',
  year_month_day: 'By year / month / day',
};

// 2026-06-20 (local) — drives the live example path shown next to each option.
const EXAMPLE_MTIME_MS = new Date(2026, 5, 20).getTime();

function examplePath(remotePath: string, mode: PathOrganization): string {
  const normalized = normalizeRemotePath(remotePath) || '/phone-backups/camera';
  const base = normalized === '/' ? '' : normalized;
  const sub = dateSubdir(EXAMPLE_MTIME_MS, mode);
  return sub ? `${base}/${sub}/photo.jpg` : `${base}/photo.jpg`;
}

export default function JobEditScreen() {
  const { id: idParam } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const db = useSQLiteContext();
  const scheme = useColorScheme() ?? 'light';

  const isNew = idParam === 'new';
  const jobId = isNew ? null : Number(idParam);

  const [servers, setServers] = useState<ServerRow[]>([]);
  const [serverId, setServerId] = useState<number | null>(null);
  const [name, setName] = useState('');
  // `sourceKind` is locked once a job is saved — changing it would
  // invalidate every row in `file_state` for this job (SAF relative paths
  // and MediaStore content URIs don't mix). On the edit screen the
  // segmented control renders as read-only.
  const [sourceKind, setSourceKind] = useState<SourceKind>('saf');
  const [sourceUri, setSourceUri] = useState('');
  const [remotePath, setRemotePath] = useState('');
  const [pathOrganization, setPathOrganization] = useState<PathOrganization>('flat');
  const [browserVisible, setBrowserVisible] = useState(false);
  const [browserConn, setBrowserConn] = useState<{
    baseUrl: string;
    password?: string;
    username?: string;
  } | null>(null);
  const [periodicEnabled, setPeriodicEnabled] = useState(false);
  const [periodicMinutes, setPeriodicMinutes] = useState(60);
  const [periodicMinutesText, setPeriodicMinutesText] = useState('60');
  const [wifiOnly, setWifiOnly] = useState(true);
  const [respectDataSaver, setRespectDataSaver] = useState(true);
  const [chargingOnly, setChargingOnly] = useState(false);
  const [maxConcurrency, setMaxConcurrency] = useState(DEFAULT_CONCURRENCY);
  const [loaded, setLoaded] = useState(isNew);
  const [saving, setSaving] = useState(false);
  // `starting` covers the gap between tapping Sync-now and the engine
  // emitting its first progress event; once `progress.activeRun` points at
  // this job the bus takes over as the source of truth.
  const [starting, setStarting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [latestRun, setLatestRun] = useState<RunRow | null>(null);
  const [runHistory, setRunHistory] = useState<RunRow[]>([]);
  const [latestErrors, setLatestErrors] = useState<RunErrorRow[]>([]);

  const progress = useSyncProgress();
  const activeRunHere =
    progress.activeRun && progress.activeRun.jobId === jobId ? progress.activeRun : null;

  useEffect(() => {
    listServers(db).then(setServers);
  }, [db]);

  useEffect(() => {
    if (isNew || jobId === null) return;
    getJob(db, jobId).then((row) => {
      if (!row) {
        Alert.alert('Job not found');
        router.back();
        return;
      }
      setServerId(row.server_id);
      setName(row.name);
      setSourceKind(row.source_kind);
      setSourceUri(row.source_uri);
      setRemotePath(row.remote_path);
      setPathOrganization(row.path_organization);
      setPeriodicEnabled(row.periodic_enabled === 1);
      setPeriodicMinutes(row.periodic_minutes);
      setPeriodicMinutesText(String(row.periodic_minutes));
      setWifiOnly(row.wifi_only === 1);
      setRespectDataSaver(row.respect_data_saver === 1);
      setChargingOnly(row.charging_only === 1);
      setMaxConcurrency(row.max_concurrency);
      setLoaded(true);
    });
  }, [db, isNew, jobId, router]);

  const refreshHistory = useCallback(async () => {
    if (isNew || jobId === null) return;
    const [latest, runs] = await Promise.all([
      getLatestRunForJob(db, jobId),
      listRunsForJob(db, jobId, 10),
    ]);
    setLatestRun(latest);
    setRunHistory(runs);
    setLatestErrors(latest ? await listRunErrors(db, latest.id) : []);
  }, [db, isNew, jobId]);

  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);


  const pickFolder = async () => {
    try {
      const res = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
      if (!res.granted) return;
      setSourceUri(res.directoryUri);
    } catch (e) {
      Alert.alert(
        'Folder picker unavailable',
        e instanceof Error ? e.message : 'SAF is Android-only — use a dev build on Android.',
      );
    }
  };

  const onBrowse = async () => {
    if (serverId === null) return;
    const server = servers.find((s) => s.id === serverId);
    if (!server) return;
    const pw = (await getServerPassword(serverId)) ?? undefined;
    setBrowserConn({
      baseUrl: server.base_url,
      password: pw,
      username: server.username ?? undefined,
    });
    setBrowserVisible(true);
  };

  // Switching source kind on the create screen wipes the source handle —
  // SAF URIs and the media sentinel are not interchangeable. On the edit
  // screen the control is disabled entirely.
  const onChangeSourceKind = (next: SourceKind) => {
    if (!isNew || next === sourceKind) return;
    setSourceKind(next);
    setSourceUri(next === 'media' ? MEDIA_SOURCE_ALL : '');
  };

  const canSave =
    serverId !== null &&
    name.trim().length > 0 &&
    sourceUri.length > 0 &&
    normalizeRemotePath(remotePath).length > 0;

  const save = async () => {
    if (!canSave || saving || serverId === null) return;
    setSaving(true);
    const clampedMinutes = Math.max(PERIODIC_MIN_INTERVAL_MIN, periodicMinutes);
    const input = {
      server_id: serverId,
      name: name.trim(),
      source_kind: sourceKind,
      source_uri: sourceUri,
      remote_path: normalizeRemotePath(remotePath),
      path_organization: pathOrganization,
      periodic_enabled: periodicEnabled,
      periodic_minutes: clampedMinutes,
      wifi_only: wifiOnly,
      respect_data_saver: respectDataSaver,
      charging_only: chargingOnly,
      max_concurrency: maxConcurrency,
    };
    try {
      if (isNew) {
        await createJob(db, input);
      } else {
        await updateJob(db, jobId!, input);
      }
      // Update the WorkManager registration whenever a job's schedule
      // state may have changed. Failures here are non-fatal — the app
      // keeps working, just without the cadence update.
      syncPeriodicRegistration(db).catch((e) => {
        console.warn('[copyparty] syncPeriodicRegistration failed', e);
      });
      router.back();
    } catch (e) {
      Alert.alert('Save failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  };

  // Toggling periodic on requires POST_NOTIFICATIONS (Android 13+) so the
  // foreground-service notification can actually be posted during ticks.
  // Ask lazily here; if denied, revert the toggle and explain why.
  const onTogglePeriodic = async (next: boolean) => {
    if (!next) {
      setPeriodicEnabled(false);
      return;
    }
    try {
      const granted = await ensureNotificationPermission();
      if (!granted) {
        Alert.alert(
          'Notifications required',
          'Periodic background sync needs notification permission so the app can keep syncing under Android battery limits. Enable notifications for copyparty and try again.',
        );
        return;
      }
      setPeriodicEnabled(true);
    } catch (e) {
      Alert.alert(
        'Could not enable periodic sync',
        e instanceof Error ? e.message : String(e),
      );
    }
  };

  const onChangePeriodicMinutes = (t: string) => {
    setPeriodicMinutesText(t);
    const n = parseInt(t, 10);
    if (!Number.isNaN(n) && n > 0) setPeriodicMinutes(n);
  };

  const commitPeriodicMinutes = () => {
    const clamped = Math.max(PERIODIC_MIN_INTERVAL_MIN, periodicMinutes);
    setPeriodicMinutes(clamped);
    setPeriodicMinutesText(String(clamped));
  };

  const confirmDelete = () => {
    if (isNew || jobId === null) return;
    Alert.alert(
      `Delete ${name || 'this job'}?`,
      'Removes the job and its sync history. Files already on the server are untouched.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await deleteJob(db, jobId);
            router.back();
          },
        },
      ],
    );
  };

  const canTest =
    !testing &&
    serverId !== null &&
    sourceUri.length > 0 &&
    normalizeRemotePath(remotePath).length > 0;

  const onTest = async () => {
    if (!canTest || serverId === null) return;
    setTesting(true);
    try {
      const server = servers.find((s) => s.id === serverId);
      if (!server) {
        Alert.alert('Test failed', 'Select a server first.');
        return;
      }
      // baseUrl is trusted: it was normalized + validated at server-save time
      // (see app/server/[id].tsx). No re-check needed here.
      const pw = (await getServerPassword(serverId)) ?? '';
      if (!pw) {
        Alert.alert(
          'Test failed',
          'No password stored for this server. Edit the server and re-enter it.',
        );
        return;
      }
      const remote = normalizeRemotePath(remotePath);
      const result = await testJobConnection({
        baseUrl: server.base_url,
        password: pw,
        username: server.username ?? undefined,
        certSha256: server.cert_sha256,
        remotePath: remote,
        sourceKind,
        sourceUri: sourceKind === 'saf' ? sourceUri || undefined : undefined,
      });
      if (!result.localOk) {
        Alert.alert(
          sourceKind === 'media' ? 'Camera-roll permission missing' : 'Local folder unavailable',
          sourceKind === 'media'
            ? 'Remote OK, but camera-roll access is not granted. Grant it and retry.'
            : 'Remote OK, but the local folder permission is gone. Re-pick it.',
        );
      } else {
        Alert.alert(
          'Connection OK',
          sourceKind === 'media'
            ? `Remote path ${remote} is writable and camera-roll access is granted.`
            : `Remote path ${remote} is writable and the local folder is accessible.`,
        );
      }
    } catch (e) {
      Alert.alert('Test failed', e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  const onSyncNow = async () => {
    if (isNew || jobId === null || starting || activeRunHere) return;
    setStarting(true);
    try {
      await runJobManual(db, jobId);
    } catch (e) {
      Alert.alert('Sync failed', e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
      refreshHistory();
    }
  };

  if (!loaded) {
    return (
      <ThemedView style={[styles.container, styles.centered]}>
        <ActivityIndicator />
      </ThemedView>
    );
  }

  const inputStyle = [
    styles.input,
    { color: Colors[scheme].text, borderColor: Colors[scheme].icon },
  ];
  const placeholder = Colors[scheme].icon;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          title: isNew ? 'New job' : name || 'Edit job',
          headerRight: () => (
            <Pressable
              onPress={save}
              disabled={!canSave || saving}
              hitSlop={8}
              accessibilityLabel="Save job">
              <ThemedText
                type="defaultSemiBold"
                style={{ color: canSave ? Colors[scheme].tint : Colors[scheme].icon }}>
                Save
              </ThemedText>
            </Pressable>
          ),
        }}
      />
      <ThemedView style={styles.container}>
        <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
          <Field label="Name">
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Camera backup"
              placeholderTextColor={placeholder}
              style={inputStyle}
              autoCapitalize="sentences"
            />
          </Field>

          <Field label="Server">
            {servers.length === 0 ? (
              <ThemedText style={styles.hint}>
                No servers configured. Add one from Settings.
              </ThemedText>
            ) : (
              <View style={styles.serverList}>
                {servers.map((s) => {
                  const selected = s.id === serverId;
                  return (
                    <Pressable
                      key={s.id}
                      onPress={() => setServerId(s.id)}
                      style={({ pressed }) => [
                        styles.serverRow,
                        selected && { borderColor: Colors[scheme].tint, borderWidth: 2 },
                        !selected && { borderColor: Colors[scheme].icon },
                        { opacity: pressed ? 0.7 : 1 },
                      ]}>
                      <View style={{ flex: 1 }}>
                        <ThemedText type="defaultSemiBold">{s.name}</ThemedText>
                        <ThemedText style={styles.serverUrl} numberOfLines={1}>
                          {s.base_url}
                        </ThemedText>
                      </View>
                      {selected ? (
                        <IconSymbol
                          name="checkmark.circle.fill"
                          color={Colors[scheme].tint}
                          size={22}
                        />
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
            )}
          </Field>

          <Field label="Source">
            <View style={styles.segmented}>
              {(['saf', 'media'] as const).map((kind) => {
                const selected = sourceKind === kind;
                const disabled = !isNew && !selected;
                return (
                  <Pressable
                    key={kind}
                    onPress={() => onChangeSourceKind(kind)}
                    disabled={disabled}
                    style={({ pressed }) => [
                      styles.segmentedBtn,
                      {
                        backgroundColor: selected ? Colors[scheme].tint : 'transparent',
                        borderColor: Colors[scheme].icon,
                        opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
                      },
                    ]}>
                    <IconSymbol
                      name={kind === 'saf' ? 'folder.fill' : 'photo.on.rectangle'}
                      color={selected ? '#fff' : Colors[scheme].tint}
                      size={16}
                    />
                    <ThemedText
                      style={{
                        color: selected ? '#fff' : Colors[scheme].tint,
                        fontWeight: '600',
                      }}>
                      {kind === 'saf' ? 'Folder' : 'Camera roll'}
                    </ThemedText>
                  </Pressable>
                );
              })}
            </View>
            {!isNew ? (
              <ThemedText style={styles.hint}>
                Source type is locked after creating a job.
              </ThemedText>
            ) : null}
          </Field>

          {sourceKind === 'saf' ? (
            <Field label="Local folder">
              <Pressable
                onPress={pickFolder}
                style={({ pressed }) => [
                  styles.pickBtn,
                  { borderColor: Colors[scheme].icon, opacity: pressed ? 0.7 : 1 },
                ]}>
                <IconSymbol name="folder.fill" color={Colors[scheme].tint} size={20} />
                <ThemedText style={{ color: Colors[scheme].tint }}>
                  {sourceUri ? 'Change folder' : 'Pick folder…'}
                </ThemedText>
              </Pressable>
              {sourceUri ? (
                <ThemedText style={styles.uri} numberOfLines={2}>
                  {decodeURIComponent(sourceUri)}
                </ThemedText>
              ) : null}
            </Field>
          ) : (
            <Field label="Camera roll scope">
              <View
                style={[
                  styles.pickBtn,
                  { borderColor: Colors[scheme].icon, gap: 8 },
                ]}>
                <IconSymbol
                  name="photo.on.rectangle"
                  color={Colors[scheme].tint}
                  size={20}
                />
                <ThemedText>All photos and videos</ThemedText>
              </View>
              <ThemedText style={styles.hint}>
                Album filtering comes in a later release.
              </ThemedText>
            </Field>
          )}

          <Field label="Remote path">
            <View style={styles.remoteRow}>
              <TextInput
                value={remotePath}
                onChangeText={setRemotePath}
                placeholder="/phone-backups/camera"
                placeholderTextColor={placeholder}
                style={[inputStyle, styles.remoteInput]}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Pressable
                onPress={onBrowse}
                disabled={serverId === null}
                style={({ pressed }) => [
                  styles.browseBtn,
                  {
                    borderColor:
                      serverId === null ? Colors[scheme].icon : Colors[scheme].tint,
                    opacity: pressed ? 0.7 : 1,
                  },
                ]}>
                <IconSymbol
                  name="folder.fill"
                  color={serverId === null ? Colors[scheme].icon : Colors[scheme].tint}
                  size={18}
                />
                <ThemedText
                  style={{
                    color: serverId === null ? Colors[scheme].icon : Colors[scheme].tint,
                    fontWeight: '600',
                  }}>
                  Browse
                </ThemedText>
              </Pressable>
            </View>
            {serverId === null ? (
              <ThemedText style={styles.hint}>
                Select a server above to browse its folders.
              </ThemedText>
            ) : null}
          </Field>

          <Field label="Organize by date">
            <View style={styles.serverList}>
              {PATH_ORGANIZATIONS.map((mode) => {
                const selected = pathOrganization === mode;
                return (
                  <Pressable
                    key={mode}
                    onPress={() => setPathOrganization(mode)}
                    style={({ pressed }) => [
                      styles.serverRow,
                      selected && { borderColor: Colors[scheme].tint, borderWidth: 2 },
                      !selected && { borderColor: Colors[scheme].icon },
                      { opacity: pressed ? 0.7 : 1 },
                    ]}>
                    <View style={{ flex: 1 }}>
                      <ThemedText type="defaultSemiBold">
                        {PATH_ORG_LABELS[mode]}
                      </ThemedText>
                      <ThemedText style={styles.serverUrl} numberOfLines={1}>
                        {examplePath(remotePath, mode)}
                      </ThemedText>
                    </View>
                    {selected ? (
                      <IconSymbol
                        name="checkmark.circle.fill"
                        color={Colors[scheme].tint}
                        size={22}
                      />
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
            <ThemedText style={styles.hint}>
              Buckets uploads into folders by each file&apos;s modification date.
              {sourceKind === 'saf'
                ? ' Date modes flatten the local subfolder structure.'
                : ''}
            </ThemedText>
          </Field>

          <Field label="Parallel uploads">
            <Stepper
              value={maxConcurrency}
              min={MIN_CONCURRENCY}
              max={MAX_CONCURRENCY}
              onChange={setMaxConcurrency}
              unit={maxConcurrency === 1 ? 'file at a time' : 'files at a time'}
            />
            <ThemedText style={styles.hint}>
              How many files upload at once. Higher fills a fast Wi-Fi link; lower
              is gentler on older phones and slow servers.
            </ThemedText>
          </Field>

          <SchedulePanel
            enabled={periodicEnabled}
            onToggleEnabled={onTogglePeriodic}
            minutesText={periodicMinutesText}
            onChangeMinutesText={onChangePeriodicMinutes}
            onCommitMinutes={commitPeriodicMinutes}
            minutes={periodicMinutes}
            wifiOnly={wifiOnly}
            onToggleWifi={setWifiOnly}
            respectDataSaver={respectDataSaver}
            onToggleDataSaver={setRespectDataSaver}
            chargingOnly={chargingOnly}
            onToggleCharging={setChargingOnly}
            lastRunStartedAt={latestRun?.started_at ?? null}
            inputStyle={inputStyle}
            placeholder={placeholder}
          />

          <Pressable
            onPress={onTest}
            disabled={!canTest}
            style={({ pressed }) => [
              styles.testBtn,
              {
                borderColor: canTest ? Colors[scheme].tint : Colors[scheme].icon,
                opacity: pressed ? 0.7 : 1,
              },
            ]}>
            <ThemedText
              style={{
                color: canTest ? Colors[scheme].tint : Colors[scheme].icon,
                fontWeight: '600',
              }}>
              {testing ? 'Testing…' : 'Test connection'}
            </ThemedText>
          </Pressable>

          {!isNew ? (
            <>
              <View style={styles.sep} />

              <View style={styles.field}>
                <ThemedText type="subtitle">Sync</ThemedText>
                <Pressable
                  onPress={onSyncNow}
                  disabled={starting || activeRunHere !== null}
                  style={({ pressed }) => [
                    styles.syncBtn,
                    {
                      backgroundColor:
                        starting || activeRunHere ? Colors[scheme].icon : Colors[scheme].tint,
                      opacity: pressed ? 0.85 : 1,
                    },
                  ]}>
                  <IconSymbol
                    name="arrow.up.circle.fill"
                    color="#fff"
                    size={22}
                  />
                  <ThemedText style={styles.syncBtnText}>
                    {activeRunHere ? 'Syncing…' : starting ? 'Starting…' : 'Sync now'}
                  </ThemedText>
                </Pressable>

                {activeRunHere ? (
                  <ActiveRunPanel run={activeRunHere} />
                ) : (
                  <LastRunPanel run={latestRun} errors={latestErrors} />
                )}
              </View>

              <View style={styles.field}>
                <ThemedText type="subtitle">Recent runs</ThemedText>
                {runHistory.length === 0 ? (
                  <ThemedText style={styles.hint}>No runs yet.</ThemedText>
                ) : (
                  runHistory.map((r) => (
                    <Pressable
                      key={r.id}
                      onPress={() => router.push(`/run/${r.id}`)}
                      style={({ pressed }) => [
                        styles.runHistoryRow,
                        { opacity: pressed ? 0.6 : 1 },
                      ]}>
                      <StatusDot status={r.status} />
                      <ThemedText style={styles.runHistoryText} numberOfLines={1}>
                        {new Date(r.started_at).toLocaleString()} · {r.status} ·{' '}
                        {r.files_uploaded}↑ / {r.files_skipped}= / {r.files_failed}✗
                      </ThemedText>
                      <IconSymbol
                        name="chevron.right"
                        color={Colors[scheme].icon}
                        size={16}
                      />
                    </Pressable>
                  ))
                )}
              </View>

              <Pressable
                onPress={confirmDelete}
                style={({ pressed }) => [
                  styles.deleteBtn,
                  { opacity: pressed ? 0.6 : 1 },
                ]}>
                <ThemedText style={styles.deleteBtnText}>Delete job</ThemedText>
              </Pressable>
            </>
          ) : null}
        </ScrollView>
        {browserConn ? (
          <RemotePathBrowser
            visible={browserVisible}
            baseUrl={browserConn.baseUrl}
            password={browserConn.password}
            username={browserConn.username}
            initialPath={normalizeRemotePath(remotePath) || '/'}
            onClose={() => setBrowserVisible(false)}
            onSelect={setRemotePath}
          />
        ) : null}
      </ThemedView>
    </KeyboardAvoidingView>
  );
}

function ActiveRunPanel({ run }: { run: ActiveRunSnapshot }) {
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
    <View style={styles.panel}>
      <ThemedText style={styles.panelLabel}>{phaseLabel(run.phase)}</ThemedText>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${pct}%` }]} />
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
        <View style={{ gap: 2 }}>
          {run.activeFiles.slice(0, 5).map((f) => {
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
          {run.activeFiles.length > 5 ? (
            <ThemedText style={styles.muted}>
              +{run.activeFiles.length - 5} more uploading…
            </ThemedText>
          ) : null}
        </View>
      ) : null}
      <ThemedText style={styles.muted}>
        {run.counters.uploaded} uploaded · {run.counters.skipped} skipped ·{' '}
        {run.counters.failed} failed
      </ThemedText>
      {run.dedupedBytes > 0 ? (
        <ThemedText style={styles.dedupText}>
          saved {formatBytes(run.dedupedBytes)} via dedup
        </ThemedText>
      ) : null}
      {run.errors.length > 0 ? (
        <View style={{ marginTop: 6, gap: 2 }}>
          {run.errors.slice(-3).map((e, i) => (
            <ThemedText key={i} style={styles.errorText} numberOfLines={1}>
              {e.phase}: {e.localPath || '(run)'} — {e.message ?? `HTTP ${e.httpStatus}`}
            </ThemedText>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function LastRunPanel({
  run,
  errors,
}: {
  run: RunRow | null;
  errors: RunErrorRow[];
}) {
  if (!run) {
    return (
      <View style={styles.panel}>
        <ThemedText style={styles.muted}>Never synced.</ThemedText>
      </View>
    );
  }
  return (
    <View style={styles.panel}>
      <View style={styles.runLine}>
        <StatusDot status={run.status} />
        <ThemedText type="defaultSemiBold">{run.status}</ThemedText>
        <ThemedText style={styles.muted}>
          · {new Date(run.started_at).toLocaleString()}
        </ThemedText>
      </View>
      <ThemedText style={styles.muted}>
        {run.files_scanned} scanned, {run.files_uploaded} uploaded,{' '}
        {run.files_skipped} skipped, {run.files_failed} failed (
        {formatBytes(run.bytes_uploaded)})
      </ThemedText>
      {errors.length > 0 ? (
        <View style={{ marginTop: 6, gap: 2 }}>
          <ThemedText style={styles.errorHeader}>
            {errors.length} error{errors.length === 1 ? '' : 's'}:
          </ThemedText>
          {errors.slice(0, 5).map((e) => (
            <ThemedText
              key={e.id}
              style={styles.errorText}
              selectable
              numberOfLines={2}>
              {e.phase}: {e.local_path || '(run)'} — {e.message ?? `HTTP ${e.http_status}`}
            </ThemedText>
          ))}
          {errors.length > 5 ? (
            <ThemedText style={styles.muted}>
              …and {errors.length - 5} more
            </ThemedText>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function StatusDot({ status }: { status: RunRow['status'] }) {
  const color =
    status === 'ok'
      ? '#2a9d3f'
      : status === 'partial'
        ? '#d08900'
        : status === 'failed'
          ? '#c33'
          : status === 'skipped'
            ? '#6a8caf'
            : '#888';
  return <View style={[styles.statusDot, { backgroundColor: color }]} />;
}

function phaseLabel(phase: 'scanning' | 'uploading' | 'finalizing'): string {
  if (phase === 'scanning') return 'Scanning folder…';
  if (phase === 'finalizing') return 'Finalizing…';
  return 'Uploading';
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function SchedulePanel(props: {
  enabled: boolean;
  onToggleEnabled: (next: boolean) => void;
  minutesText: string;
  onChangeMinutesText: (t: string) => void;
  onCommitMinutes: () => void;
  minutes: number;
  wifiOnly: boolean;
  onToggleWifi: (v: boolean) => void;
  respectDataSaver: boolean;
  onToggleDataSaver: (v: boolean) => void;
  chargingOnly: boolean;
  onToggleCharging: (v: boolean) => void;
  lastRunStartedAt: number | null;
  inputStyle: object[];
  placeholder: string;
}) {
  const scheme = useColorScheme() ?? 'light';
  const nextAt = props.enabled
    ? nextPeriodicRunAt(
        { periodic_enabled: 1, periodic_minutes: props.minutes },
        props.lastRunStartedAt,
        Date.now(),
      )
    : null;
  return (
    <View style={styles.field}>
      <ThemedText style={styles.fieldLabel}>Schedule</ThemedText>
      <View style={styles.scheduleRow}>
        <ThemedText style={{ flex: 1 }}>Periodic background sync</ThemedText>
        <Switch value={props.enabled} onValueChange={props.onToggleEnabled} />
      </View>
      {props.enabled ? (
        <>
          <View style={styles.scheduleIntervalRow}>
            <ThemedText>Every</ThemedText>
            <TextInput
              value={props.minutesText}
              onChangeText={props.onChangeMinutesText}
              onBlur={props.onCommitMinutes}
              keyboardType="number-pad"
              style={[...props.inputStyle, styles.intervalInput]}
              placeholder="60"
              placeholderTextColor={props.placeholder}
            />
            <ThemedText>minutes</ThemedText>
          </View>
          <ThemedText style={styles.hint}>
            Minimum {PERIODIC_MIN_INTERVAL_MIN} minutes. Android may delay ticks
            further under battery optimization.
          </ThemedText>

          <View style={styles.scheduleRow}>
            <ThemedText style={{ flex: 1 }}>Wi-Fi only</ThemedText>
            <Switch value={props.wifiOnly} onValueChange={props.onToggleWifi} />
          </View>
          <View style={styles.scheduleRow}>
            <View style={{ flex: 1 }}>
              <ThemedText>Respect Data Saver</ThemedText>
              <ThemedText style={styles.hint}>
                Best-effort detection; improving soon.
              </ThemedText>
            </View>
            <Switch
              value={props.respectDataSaver}
              onValueChange={props.onToggleDataSaver}
            />
          </View>
          <View style={styles.scheduleRow}>
            <ThemedText style={{ flex: 1 }}>Charging only</ThemedText>
            <Switch
              value={props.chargingOnly}
              onValueChange={props.onToggleCharging}
            />
          </View>

          <ThemedText style={[styles.hint, { color: Colors[scheme].tint }]}>
            Next run: {nextRunLabel(nextAt, Date.now())}
          </ThemedText>
        </>
      ) : (
        <ThemedText style={styles.hint}>
          Off — syncs only when you tap Sync now.
        </ThemedText>
      )}
    </View>
  );
}

function nextRunLabel(at: number | null, now: number): string {
  if (at === null) return '—';
  const diff = at - now;
  const absDate = new Date(at).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
  if (diff <= 0) return `overdue · ${absDate}`;
  const totalMin = Math.round(diff / 60_000);
  if (totalMin < 60) return `in ${totalMin}m · ${absDate}`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `in ${h}h ${m}m · ${absDate}`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <ThemedText style={styles.fieldLabel}>{label}</ThemedText>
      {children}
    </View>
  );
}

function Stepper({
  value,
  min,
  max,
  onChange,
  unit,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  unit: string;
}) {
  const scheme = useColorScheme() ?? 'light';
  const atMin = value <= min;
  const atMax = value >= max;
  const btnStyle = (disabled: boolean) => ({ pressed }: { pressed: boolean }) => [
    styles.stepperBtn,
    {
      borderColor: disabled ? Colors[scheme].icon : Colors[scheme].tint,
      opacity: disabled ? 0.4 : pressed ? 0.6 : 1,
    },
  ];
  return (
    <View style={styles.stepperRow}>
      <Pressable
        onPress={() => onChange(Math.max(min, value - 1))}
        disabled={atMin}
        hitSlop={6}
        accessibilityLabel="Fewer parallel uploads"
        style={btnStyle(atMin)}>
        <ThemedText style={[styles.stepperGlyph, { color: Colors[scheme].tint }]}>
          −
        </ThemedText>
      </Pressable>
      <View style={styles.stepperValueWrap}>
        <ThemedText type="defaultSemiBold" style={styles.stepperValue}>
          {value}
        </ThemedText>
        <ThemedText style={styles.hint}>{unit}</ThemedText>
      </View>
      <Pressable
        onPress={() => onChange(Math.min(max, value + 1))}
        disabled={atMax}
        hitSlop={6}
        accessibilityLabel="More parallel uploads"
        style={btnStyle(atMax)}>
        <ThemedText style={[styles.stepperGlyph, { color: Colors[scheme].tint }]}>
          +
        </ThemedText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { alignItems: 'center', justifyContent: 'center' },
  form: { padding: 16, gap: 16 },
  field: { gap: 6 },
  fieldLabel: { fontSize: 13, opacity: 0.75 },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  remoteRow: { flexDirection: 'row', alignItems: 'stretch', gap: 8 },
  remoteInput: { flex: 1 },
  browseBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 14,
  },
  serverList: { gap: 8 },
  serverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: 10,
    gap: 8,
  },
  serverUrl: { opacity: 0.7, fontSize: 13 },
  pickBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  segmented: {
    flexDirection: 'row',
    gap: 8,
  },
  segmentedBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingVertical: 10,
  },
  uri: { opacity: 0.7, fontSize: 11, marginTop: 4 },
  hint: { opacity: 0.7, fontSize: 13 },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: '#8885', marginVertical: 4 },
  syncBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 8,
  },
  syncBtnText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  panel: {
    gap: 6,
    padding: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#8884',
  },
  panelLabel: { fontSize: 12, opacity: 0.7 },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: '#8883',
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: '#2a9d3f' },
  progressRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fileName: { flex: 1, fontSize: 12, opacity: 0.85 },
  filePct: { fontSize: 12, opacity: 0.7, fontVariant: ['tabular-nums'] },
  dedupText: { fontSize: 12, color: '#2a9d3f' },
  muted: { opacity: 0.7, fontSize: 12 },
  runLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  errorHeader: { fontSize: 12, color: '#c33', fontWeight: '600' },
  errorText: { fontSize: 11, color: '#c33' },
  runHistoryRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 },
  runHistoryText: { flex: 1, fontSize: 12, opacity: 0.8 },
  testBtn: {
    padding: 14,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  deleteBtn: {
    marginTop: 12,
    padding: 14,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#c33',
    alignItems: 'center',
  },
  deleteBtnText: { color: '#c33', fontWeight: '600' },
  scheduleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 6,
  },
  scheduleIntervalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
  },
  intervalInput: {
    width: 72,
    textAlign: 'center',
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stepperBtn: {
    width: 44,
    height: 44,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperGlyph: { fontSize: 24, lineHeight: 28, fontWeight: '600' },
  stepperValueWrap: { flex: 1, alignItems: 'center' },
  stepperValue: { fontSize: 22, lineHeight: 26 },
});
