import { useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors } from '@/constants/theme';
import { useAppPermissions } from '@/hooks/use-app-permissions';
import { useAsyncAction } from '@/hooks/use-async-action';
import { useColorScheme } from '@/hooks/use-color-scheme';
import CopypartySync from '@/modules/copyparty-sync';
import { APP_NAME } from '@/src/app-name';
import { requestMediaReadAccess } from '@/src/media/media-permission';
import { requestOriginalBytesWithEscalation } from '@/src/media/request-original-bytes';
import type {
  PermissionAction,
  PermissionItem,
  PermissionStatus,
  RequirementLevel,
} from '@/src/permissions/permissions-eval';
import { requestNotificationPermission } from '@/src/sync/notify-permission';

/**
 * App permissions checklist: one row per permission the app can hold, each
 * saying what it is for and — when it is optional — exactly what leaving it off
 * costs. Sibling of the background-sync checklist, which covers device settings
 * rather than permissions.
 *
 * Unlike that screen, the buttons here ask in-app first and only fall back to
 * system settings once Android stops showing the dialog, so most rows resolve
 * without ever leaving the app.
 */
export default function PermissionsScreen() {
  const db = useSQLiteContext();
  const router = useRouter();
  const scheme = useColorScheme() ?? 'light';
  const insets = useSafeAreaInsets();
  const { items, refresh } = useAppPermissions(db);

  const onAction = useCallback(
    async (item: PermissionItem) => {
      try {
        switch (item.action) {
          case 'request_media_read':
            await grantMediaRead();
            break;
          case 'request_original_bytes':
            await requestOriginalBytesWithEscalation(refresh);
            break;
          case 'request_notifications':
            await grantNotifications();
            break;
          case 'app_settings':
            await CopypartySync?.openAppSettings();
            break;
          case 'repick_folder':
            if (item.jobId != null) router.push(`/job/${item.jobId}/edit`);
            break;
        }
      } catch (e) {
        console.warn('[copyparty] permission action failed', e);
      } finally {
        // An in-app request never backgrounds the app, so nothing else would
        // refresh the row it just changed.
        refresh();
      }
    },
    [refresh, router],
  );

  if (Platform.OS !== 'android') {
    return (
      <ThemedView style={[styles.container, styles.centered]}>
        <ThemedText style={styles.dim}>App permissions only apply to Android.</ThemedText>
      </ThemedView>
    );
  }

  const appItems = items.filter((i) => i.section === 'app');
  const folderItems = items.filter((i) => i.section === 'folders');

  return (
    <ThemedView style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 16 }]}>
        <ThemedText style={styles.blurb}>
          These are the app-wide permissions Android lists under App info → Permissions.
          {' '}{APP_NAME} asks for the minimum it needs; each one below is either required by
          a job you already have, or says exactly what you give up by leaving it off.
        </ThemedText>

        {appItems.map((item) => (
          <PermissionRow key={item.id} item={item} scheme={scheme} onAction={onAction} />
        ))}

        {folderItems.length ? (
          <>
            <ThemedText type="subtitle" style={styles.sectionHeading}>
              Folder access
            </ThemedText>
            <ThemedText style={styles.blurb}>
              A folder backup does not use an app-wide permission. You grant access to one
              specific folder when you pick it, and Android remembers that single grant for
              that job — it never appears in the permission list above. The grant is lost if
              the folder is moved or deleted, if its storage is unmounted, or if Android
              clears the app&apos;s saved grants.
            </ThemedText>
            {folderItems.map((item) => (
              <PermissionRow key={item.id} item={item} scheme={scheme} onAction={onAction} />
            ))}
          </>
        ) : null}
      </ScrollView>
    </ThemedView>
  );
}

/**
 * Ask for the camera roll in-app, and only send the user to system settings if
 * Android gave them less than everything — 'partial' is a real outcome of the
 * Android 14 picker, not a failure, so it gets its own explanation.
 */
async function grantMediaRead() {
  const state = await requestMediaReadAccess();
  if (state === 'partial') {
    settingsAlert(
      'Still limited to the photos you picked',
      'Choose “Allow all” under Photos and videos in system settings to back up your ' +
        'whole camera roll.',
    );
  } else if (state === 'denied') {
    settingsAlert(
      'Photo access is blocked',
      'Android is no longer showing the permission prompt. Allow Photos and videos in ' +
        'system settings.',
    );
  }
}

/**
 * 'granted' is not the end of it: the runtime permission reads as held while the
 * app's notifications are switched off wholesale, and below API 33 it is always
 * 'granted'. The native probe is the real answer, so re-check it before
 * declaring victory.
 */
async function grantNotifications() {
  const perm = await requestNotificationPermission();
  const enabled = perm === 'granted' && (CopypartySync?.areNotificationsEnabled?.() ?? true);
  if (enabled) return;

  Alert.alert(
    'Notifications are off',
    `Syncs will still run, but you will not see progress or failures. Turn notifications ` +
      `on for ${APP_NAME} in system settings.`,
    [
      { text: 'Not now', style: 'cancel' },
      {
        text: 'Open settings',
        onPress: () => {
          CopypartySync?.openNotificationSettings().catch(() => {});
        },
      },
    ],
  );
}

function settingsAlert(title: string, body: string) {
  Alert.alert(title, body, [
    { text: 'Not now', style: 'cancel' },
    {
      text: 'Open settings',
      onPress: () => {
        CopypartySync?.openAppSettings().catch(() => {});
      },
    },
  ]);
}

function PermissionRow({
  item,
  scheme,
  onAction,
}: {
  item: PermissionItem;
  scheme: 'light' | 'dark';
  onAction: (item: PermissionItem) => void;
}) {
  const c = Colors[scheme];
  // 'app_settings' leaves for a system screen and so clears on backgrounding;
  // the in-app requests resolve when the user answers the dialog. Per-row, so a
  // pending action survives the re-probe that rebuilds `items` underneath it.
  const handsOff = item.action === 'app_settings';
  const act = useAsyncAction(() => onAction(item), {
    handsOff,
    errorTitle: handsOff ? 'Could not open app settings' : undefined,
    errorBody: handsOff
      ? `You can get there from Android Settings → Apps → ${APP_NAME}.`
      : undefined,
  });

  return (
    <View style={[styles.row, { borderColor: c.border }]}>
      {item.status === 'checking' ? (
        // Same 22pt slot as the icon it replaces, so the row does not shift
        // when the folder probe lands.
        <View style={styles.statusSlot}>
          <ActivityIndicator size="small" color={c.muted} />
        </View>
      ) : (
        <IconSymbol
          name={statusIcon(item.status)}
          color={statusTint(item.status, scheme)}
          size={22}
        />
      )}
      <View style={styles.rowBody}>
        <View style={styles.titleRow}>
          <ThemedText type="defaultSemiBold" style={styles.title}>
            {item.title}
          </ThemedText>
          <ThemedText style={[styles.pill, { color: levelTint(item.level, scheme) }]}>
            {levelLabel(item.level)}
          </ThemedText>
        </View>
        <ThemedText style={styles.detail}>{item.detail}</ThemedText>
        {item.caveat ? (
          <ThemedText style={styles.detail}>If you leave this off: {item.caveat}</ThemedText>
        ) : null}
        {item.action ? (
          <Pressable
            onPress={act.run}
            disabled={act.pending}
            accessibilityRole="button"
            accessibilityLabel={`${actionLabel(item.action)} for ${item.title}`}
            accessibilityState={{ disabled: act.pending, busy: act.pending }}
            style={({ pressed }) => [
              styles.actionButton,
              { borderColor: c.tint, opacity: act.pending ? 0.5 : pressed ? 0.6 : 1 },
            ]}>
            {act.pending ? <ActivityIndicator size="small" color={c.tint} /> : null}
            <ThemedText style={[styles.actionLabel, { color: c.tint }]}>
              {act.pending
                ? handsOff
                  ? 'Opening…'
                  : 'Asking…'
                : actionLabel(item.action)}
            </ThemedText>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/** 'checking' renders a spinner instead of an icon, so it never reaches these. */
type SettledStatus = Exclude<PermissionStatus, 'checking'>;

function statusIcon(status: SettledStatus) {
  switch (status) {
    case 'ok':
      return 'checkmark.circle.fill' as const;
    case 'warn':
      return 'exclamationmark.triangle.fill' as const;
    case 'blocked':
      return 'xmark.circle.fill' as const;
  }
}

function statusTint(status: SettledStatus, scheme: 'light' | 'dark'): string {
  const c = Colors[scheme];
  switch (status) {
    case 'ok':
      return c.success;
    case 'warn':
      return c.warning;
    case 'blocked':
      return c.danger;
  }
}

function levelLabel(level: RequirementLevel): string {
  switch (level) {
    case 'required':
      return 'REQUIRED';
    case 'recommended':
      return 'RECOMMENDED';
    case 'optional':
      return 'OPTIONAL';
  }
}

function levelTint(level: RequirementLevel, scheme: 'light' | 'dark'): string {
  const c = Colors[scheme];
  switch (level) {
    case 'required':
      return c.danger;
    case 'recommended':
      return c.warning;
    case 'optional':
      return c.muted;
  }
}

function actionLabel(action: PermissionAction): string {
  switch (action) {
    case 'request_media_read':
      return 'Allow photo access';
    case 'request_original_bytes':
      return 'Allow photo location';
    case 'request_notifications':
      return 'Turn on notifications';
    case 'app_settings':
      return 'Open app settings';
    case 'repick_folder':
      return 'Re-pick folder';
  }
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: 16, gap: 12 },
  blurb: { opacity: 0.7, fontSize: 14, marginBottom: 4 },
  sectionHeading: { marginTop: 12 },
  row: {
    flexDirection: 'row',
    gap: 12,
    padding: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'flex-start',
  },
  rowBody: { flex: 1, gap: 4 },
  statusSlot: { width: 22, alignItems: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  title: { flexShrink: 1 },
  pill: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  detail: { opacity: 0.7, fontSize: 13, lineHeight: 18 },
  actionButton: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginTop: 4,
  },
  actionLabel: { fontSize: 14, fontWeight: '600' },
  dim: { opacity: 0.6 },
});
