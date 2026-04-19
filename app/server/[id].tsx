import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { testServerConnection } from '@/src/copyparty/test-connection';
import {
  createServer,
  deleteServer,
  getServer,
  updateServer,
} from '@/src/db/servers';
import {
  deleteServerPassword,
  getServerPassword,
  setServerPassword,
} from '@/src/storage/secrets';

const HEX64 = /^[0-9a-f]{64}$/;

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

function normalizeFingerprint(raw: string): string {
  return raw.trim().toLowerCase().replace(/[:\s]/g, '');
}

export default function ServerEditScreen() {
  const { id: idParam } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const db = useSQLiteContext();
  const scheme = useColorScheme() ?? 'light';

  const isNew = idParam === 'new';
  const serverId = isNew ? null : Number(idParam);

  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [certSha, setCertSha] = useState('');
  const [loaded, setLoaded] = useState(isNew);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  // Tracks whether a stored password exists for the edited server. Used to
  // enable the Test button when the password field is blank (edit mode).
  const [hasStoredSecret, setHasStoredSecret] = useState(false);

  useEffect(() => {
    if (isNew || serverId === null) return;
    getServer(db, serverId).then((row) => {
      if (!row) {
        Alert.alert('Server not found');
        router.back();
        return;
      }
      setName(row.name);
      setBaseUrl(row.base_url);
      setUsername(row.username ?? '');
      setCertSha(row.cert_sha256 ?? '');
      setLoaded(true);
    });
    getServerPassword(serverId).then((pw) => setHasStoredSecret(!!pw));
  }, [db, isNew, serverId, router]);

  const passwordRequired = isNew;
  const canSave =
    name.trim().length > 0 &&
    baseUrl.trim().length > 0 &&
    /^https?:\/\//i.test(baseUrl.trim()) &&
    (!passwordRequired || password.length > 0) &&
    (certSha.trim().length === 0 || HEX64.test(normalizeFingerprint(certSha)));

  const save = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    const input = {
      name: name.trim(),
      base_url: normalizeBaseUrl(baseUrl),
      username: username.trim() || null,
      cert_sha256: certSha.trim() ? normalizeFingerprint(certSha) : null,
    };
    try {
      let id: number;
      if (isNew) {
        id = await createServer(db, input);
        try {
          await setServerPassword(id, password);
        } catch (e) {
          // secret write failed — roll back the row so we don't orphan it
          await deleteServer(db, id).catch(() => {});
          throw e;
        }
      } else {
        id = serverId!;
        await updateServer(db, id, input);
        if (password.length > 0) {
          await setServerPassword(id, password);
        }
      }
      router.back();
    } catch (e) {
      Alert.alert(
        'Save failed',
        e instanceof Error ? e.message : 'Unknown error',
      );
    } finally {
      setSaving(false);
    }
  };

  const canTest =
    !testing &&
    baseUrl.trim().length > 0 &&
    (password.length > 0 || (!isNew && hasStoredSecret));

  const onTest = async () => {
    if (!canTest) return;
    setTesting(true);
    try {
      if (!/^https?:\/\//i.test(baseUrl.trim())) {
        Alert.alert('Test failed', 'URL must start with http:// or https://.');
        return;
      }
      let pw = password;
      if (!pw && !isNew && serverId !== null) {
        pw = (await getServerPassword(serverId)) ?? '';
      }
      await testServerConnection({
        baseUrl: normalizeBaseUrl(baseUrl),
        password: pw,
        certSha256: certSha.trim() ? normalizeFingerprint(certSha) : null,
      });
      Alert.alert('Connection OK', 'Server responded and auth was accepted.');
    } catch (e) {
      Alert.alert('Test failed', e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  const confirmDelete = () => {
    if (isNew || serverId === null) return;
    Alert.alert(
      `Delete ${name || 'this server'}?`,
      'This removes the server and any jobs that use it.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await deleteServer(db, serverId);
            await deleteServerPassword(serverId).catch(() => {});
            router.back();
          },
        },
      ],
    );
  };

  if (!loaded) {
    return <ThemedView style={styles.container} />;
  }

  const inputStyle = [
    styles.input,
    {
      color: Colors[scheme].text,
      borderColor: Colors[scheme].icon,
    },
  ];
  const placeholder = Colors[scheme].icon;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          title: isNew ? 'New server' : name || 'Edit server',
          headerRight: () => (
            <Pressable
              onPress={save}
              disabled={!canSave || saving}
              hitSlop={8}
              accessibilityLabel="Save server">
              <ThemedText
                type="defaultSemiBold"
                style={{
                  color: canSave ? Colors[scheme].tint : Colors[scheme].icon,
                }}>
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
              placeholder="Home NAS"
              placeholderTextColor={placeholder}
              style={inputStyle}
              autoCapitalize="words"
            />
          </Field>

          <Field label="Base URL">
            <TextInput
              value={baseUrl}
              onChangeText={setBaseUrl}
              placeholder="https://copyparty.local:3923"
              placeholderTextColor={placeholder}
              style={inputStyle}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
          </Field>

          <Field label="Username (optional)">
            <TextInput
              value={username}
              onChangeText={setUsername}
              placeholder="jonny"
              placeholderTextColor={placeholder}
              style={inputStyle}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>

          <Field
            label={
              isNew ? 'Password' : 'Password (leave blank to keep existing)'
            }>
            <View style={styles.passwordRow}>
              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder={isNew ? 'required' : '••••••••'}
                placeholderTextColor={placeholder}
                style={[inputStyle, styles.passwordInput]}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry={!showPassword}
              />
              <Pressable
                onPress={() => setShowPassword((s) => !s)}
                style={styles.revealBtn}>
                <ThemedText style={{ color: Colors[scheme].tint }}>
                  {showPassword ? 'Hide' : 'Show'}
                </ThemedText>
              </Pressable>
            </View>
          </Field>

          <Field label="Pin certificate SHA-256 (optional, for self-signed)">
            <TextInput
              value={certSha}
              onChangeText={setCertSha}
              placeholder="64 hex characters"
              placeholderTextColor={placeholder}
              style={inputStyle}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {certSha.trim().length > 0 && !HEX64.test(normalizeFingerprint(certSha)) ? (
              <ThemedText style={styles.errorText}>
                Fingerprint must be 64 hex characters (colons and spaces ok).
              </ThemedText>
            ) : null}
          </Field>

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
            <Pressable
              onPress={confirmDelete}
              style={({ pressed }) => [
                styles.deleteBtn,
                { opacity: pressed ? 0.6 : 1 },
              ]}>
              <ThemedText style={styles.deleteBtnText}>Delete server</ThemedText>
            </Pressable>
          ) : null}
        </ScrollView>
      </ThemedView>
    </KeyboardAvoidingView>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <ThemedText style={styles.fieldLabel}>{label}</ThemedText>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
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
  passwordRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  passwordInput: { flex: 1 },
  revealBtn: { paddingHorizontal: 8, paddingVertical: 8 },
  errorText: { color: '#c33', fontSize: 12 },
  testBtn: {
    marginTop: 8,
    padding: 14,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  deleteBtn: {
    marginTop: 8,
    padding: 14,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#c33',
    alignItems: 'center',
  },
  deleteBtnText: { color: '#c33', fontWeight: '600' },
});
