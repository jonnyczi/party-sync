import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import type { SqliteDb } from '@/src/db/adapter';
import { listJobs } from '@/src/db/jobs';
import { listServers } from '@/src/db/servers';
import { getResultNotificationsEnabled } from '@/src/db/settings';
import { getServerPassword, setServerPassword } from '@/src/storage/secrets';

import type { RandomBytes } from './crypto';
import type { ImportDeps } from './import';
import type { BackupBundleV1 } from './schema';
import { buildBundle } from './serialize';

// Thin native layer for the backup feature. All expo-* imports live here so the
// pure modules (schema / serialize / crypto / import) stay unit-testable.

/** Cryptographically-secure RNG backed by the platform keystore. */
export const runtimeRng: RandomBytes = (n) => Crypto.getRandomBytes(n);

/** Real secret writer for importBundle (kept out of the pure import module). */
export const importDeps: ImportDeps = { setPassword: setServerPassword };

function appVersion(): string {
  return Constants.expoConfig?.version ?? 'unknown';
}

/** Read every server (+ password when requested) and job into a bundle. */
export async function collectBundle(
  db: SqliteDb,
  includePasswords: boolean,
): Promise<BackupBundleV1> {
  const servers = await listServers(db);
  const jobs = await listJobs(db);
  const passwords = new Map<number, string | null>();
  if (includePasswords) {
    for (const s of servers) {
      passwords.set(s.id, await getServerPassword(s.id));
    }
  }
  return buildBundle({
    servers,
    jobs,
    passwords,
    includePasswords,
    resultNotifications: await getResultNotificationsEnabled(db),
    appVersion: appVersion(),
  });
}

function timestampedName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `copyparty-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
}

/**
 * Write the bundle/envelope text to a cache file and open the OS share sheet.
 * Returns false if sharing is unavailable on this platform.
 */
export async function exportToFile(text: string): Promise<boolean> {
  const uri = `${FileSystem.cacheDirectory}${timestampedName()}`;
  await FileSystem.writeAsStringAsync(uri, text, {
    encoding: FileSystem.EncodingType.UTF8,
  });
  if (!(await Sharing.isAvailableAsync())) return false;
  await Sharing.shareAsync(uri, {
    mimeType: 'application/json',
    dialogTitle: 'Export copyparty settings',
    UTI: 'public.json',
  });
  return true;
}

/**
 * Let the user pick a backup file and return its text contents, or null if the
 * picker was cancelled.
 */
export async function pickAndReadFile(): Promise<string | null> {
  const res = await DocumentPicker.getDocumentAsync({
    type: ['application/json', 'text/plain', '*/*'],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (res.canceled || !res.assets?.length) return null;
  return FileSystem.readAsStringAsync(res.assets[0].uri, {
    encoding: FileSystem.EncodingType.UTF8,
  });
}
