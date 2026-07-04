import { Stack } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { decryptBundle, encryptBundle, isEncryptedEnvelope } from '@/src/backup/crypto';
import { importBundle } from '@/src/backup/import';
import {
  collectBundle,
  exportToFile,
  importDeps,
  pickAndReadFile,
  runtimeRng,
} from '@/src/backup/io';
import type { BackupBundleV1 } from '@/src/backup/schema';
import { parseBundle, serializeBundle } from '@/src/backup/serialize';
import { syncPeriodicRegistration } from '@/src/sync/scheduler-register';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function BackupScreen() {
  const db = useSQLiteContext();
  const scheme = useColorScheme() ?? 'light';
  const insets = useSafeAreaInsets();

  const [includePasswords, setIncludePasswords] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);

  const [pendingEnvelope, setPendingEnvelope] = useState<string | null>(null);
  const [importPassphrase, setImportPassphrase] = useState('');

  const tint = Colors[scheme].tint;
  const inputStyle = [
    styles.input,
    { color: Colors[scheme].text, borderColor: Colors[scheme].icon },
  ];

  async function buildExportText(): Promise<string> {
    const bundle = await collectBundle(db, includePasswords);
    if (bundle.servers.length === 0) {
      throw new Error('There are no servers to export yet.');
    }
    let text = serializeBundle(bundle);
    const pp = passphrase.trim();
    if (pp) text = await encryptBundle(text, pp, runtimeRng);
    return text;
  }

  function requirePassphraseOk(): boolean {
    if (includePasswords && !passphrase.trim()) {
      Alert.alert(
        'Passphrase required',
        'Including passwords encrypts the backup. Enter a passphrase you will remember — it is needed to import on the other device.',
      );
      return false;
    }
    return true;
  }

  async function onExportFile() {
    if (busy || !requirePassphraseOk()) return;
    setBusy(true);
    try {
      const shared = await exportToFile(await buildExportText());
      if (!shared) {
        Alert.alert('Sharing unavailable', 'The share sheet is not available on this device.');
      }
    } catch (e) {
      Alert.alert('Export failed', errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleImportText(text: string) {
    if (isEncryptedEnvelope(text)) {
      setImportPassphrase('');
      setPendingEnvelope(text); // opens the passphrase modal
      return;
    }
    confirmAndImport(parseBundle(text));
  }

  async function onImportFile() {
    if (busy) return;
    setBusy(true);
    try {
      const text = await pickAndReadFile();
      if (text === null) return; // cancelled
      await handleImportText(text);
    } catch (e) {
      Alert.alert('Import failed', errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function onSubmitImportPassphrase() {
    if (!pendingEnvelope || busy) return;
    setBusy(true);
    try {
      const plain = await decryptBundle(pendingEnvelope, importPassphrase);
      const bundle = parseBundle(plain);
      setPendingEnvelope(null);
      setImportPassphrase('');
      confirmAndImport(bundle);
    } catch (e) {
      Alert.alert('Could not open backup', errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  function confirmAndImport(bundle: BackupBundleV1) {
    Alert.alert(
      'Import this backup?',
      `Found ${bundle.servers.length} server(s) and ${bundle.jobs.length} job(s). Your existing entries are kept; duplicates are skipped.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Import', onPress: () => void applyImport(bundle) },
      ],
    );
  }

  async function applyImport(bundle: BackupBundleV1) {
    setBusy(true);
    try {
      const s = await importBundle(db, bundle, importDeps);
      await syncPeriodicRegistration(db).catch(() => {});
      const lines = [
        `Servers: ${s.serversAdded} added, ${s.serversSkipped} skipped.`,
        `Jobs: ${s.jobsAdded} added, ${s.jobsSkipped} skipped.`,
      ];
      if (s.jobsNeedingSource > 0) {
        lines.push(
          `\n${s.jobsNeedingSource} folder job(s) still need a local folder — open each from the Jobs tab and pick its folder.`,
        );
      }
      Alert.alert('Import complete', lines.join('\n'));
    } catch (e) {
      Alert.alert('Import failed', errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'Backup & restore', presentation: 'modal' }} />
      <ThemedView style={styles.container}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <ThemedText style={styles.intro}>
            Export your servers and sync jobs to move them to another device.
            Passwords are only included when you set a passphrase, which encrypts
            the backup file.
          </ThemedText>

          {/* Export */}
          <View style={styles.section}>
            <ThemedText type="subtitle">Export</ThemedText>

            <View style={styles.switchRow}>
              <View style={{ flex: 1 }}>
                <ThemedText>Include passwords</ThemedText>
                <ThemedText style={styles.hint}>
                  Requires a passphrase; the backup is encrypted.
                </ThemedText>
              </View>
              <Switch
                value={includePasswords}
                onValueChange={setIncludePasswords}
              />
            </View>

            <View style={styles.field}>
              <ThemedText style={styles.fieldLabel}>
                Passphrase {includePasswords ? '(required)' : '(optional — encrypts the file)'}
              </ThemedText>
              <TextInput
                value={passphrase}
                onChangeText={setPassphrase}
                placeholder="Choose a passphrase"
                placeholderTextColor={Colors[scheme].icon}
                style={inputStyle}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            <Pressable
              onPress={onExportFile}
              disabled={busy}
              style={({ pressed }) => [
                styles.primaryBtn,
                { backgroundColor: tint, opacity: busy ? 0.5 : pressed ? 0.8 : 1 },
              ]}>
              <IconSymbol name="square.and.arrow.up" color="#fff" size={20} />
              <ThemedText style={styles.primaryBtnText}>Export to file</ThemedText>
            </Pressable>
          </View>

          <View style={styles.sep} />

          {/* Import */}
          <View style={styles.section}>
            <ThemedText type="subtitle">Import</ThemedText>
            <ThemedText style={styles.hint}>
              Folder (SAF) jobs import as templates — you re-pick their local
              folder afterwards. Camera-roll jobs import ready to use.
            </ThemedText>

            <Pressable
              onPress={onImportFile}
              disabled={busy}
              style={({ pressed }) => [
                styles.primaryBtn,
                { backgroundColor: tint, opacity: busy ? 0.5 : pressed ? 0.8 : 1 },
              ]}>
              <IconSymbol name="square.and.arrow.down" color="#fff" size={20} />
              <ThemedText style={styles.primaryBtnText}>Import from file</ThemedText>
            </Pressable>
          </View>
        </ScrollView>
      </ThemedView>

      {/* Import passphrase prompt (Alert.prompt is iOS-only, so use a Modal) */}
      <Modal
        visible={pendingEnvelope !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setPendingEnvelope(null)}>
        <View style={styles.backdrop}>
          <ThemedView style={[styles.promptCard, { paddingBottom: insets.bottom + 16 }]}>
            <ThemedText type="defaultSemiBold">Encrypted backup</ThemedText>
            <ThemedText style={styles.hint}>
              Enter the passphrase used when this backup was exported.
            </ThemedText>
            <TextInput
              value={importPassphrase}
              onChangeText={setImportPassphrase}
              placeholder="Passphrase"
              placeholderTextColor={Colors[scheme].icon}
              style={inputStyle}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              onSubmitEditing={onSubmitImportPassphrase}
            />
            <View style={styles.promptRow}>
              <Pressable
                onPress={() => {
                  setPendingEnvelope(null);
                  setImportPassphrase('');
                }}
                style={({ pressed }) => [styles.promptBtn, { opacity: pressed ? 0.6 : 1 }]}>
                <ThemedText style={{ color: Colors[scheme].icon, fontWeight: '600' }}>
                  Cancel
                </ThemedText>
              </Pressable>
              <Pressable
                onPress={onSubmitImportPassphrase}
                disabled={busy || !importPassphrase}
                style={({ pressed }) => [
                  styles.promptBtn,
                  { opacity: busy || !importPassphrase ? 0.4 : pressed ? 0.6 : 1 },
                ]}>
                <ThemedText style={{ color: tint, fontWeight: '700' }}>Decrypt</ThemedText>
              </Pressable>
            </View>
          </ThemedView>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16, gap: 20 },
  intro: { opacity: 0.8, lineHeight: 20 },
  section: { gap: 12 },
  field: { gap: 6 },
  fieldLabel: { fontSize: 13, opacity: 0.75 },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  hint: { opacity: 0.7, fontSize: 13, lineHeight: 18 },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: 8,
  },
  primaryBtnText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: '#8885' },
  backdrop: {
    flex: 1,
    backgroundColor: '#0008',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  promptCard: {
    alignSelf: 'stretch',
    borderRadius: 16,
    padding: 20,
    gap: 12,
  },
  promptRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  promptBtn: { paddingVertical: 10, paddingHorizontal: 16 },
});
