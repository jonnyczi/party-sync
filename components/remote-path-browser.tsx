import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { browseFolder } from '@/src/copyparty/browse';
import { childPath, parentPath } from '@/src/copyparty/paths';
import { TestConnectionError } from '@/src/copyparty/test-connection';

type Props = {
  visible: boolean;
  baseUrl: string;
  password?: string;
  /** Folder the browser opens on; falls back to root if it can't be listed. */
  initialPath: string;
  onClose: () => void;
  onSelect: (path: string) => void;
};

/**
 * Full-screen folder picker for a copyparty server, presented as an in-screen
 * RN Modal so it overlays the (router-modal) job editor without unmounting it.
 * Navigates folders only; "Use this folder" hands the current path back via
 * {@link Props.onSelect}.
 */
export function RemotePathBrowser({
  visible,
  baseUrl,
  password,
  initialPath,
  onClose,
  onSelect,
}: Props) {
  const scheme = useColorScheme() ?? 'light';
  const insets = useSafeAreaInsets();
  const [path, setPath] = useState('/');
  const [dirs, setDirs] = useState<string[]>([]);
  const [writable, setWritable] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (p: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await browseFolder({ baseUrl, password, path: p });
        setPath(p);
        setDirs(res.dirs);
        setWritable(res.writable);
      } catch (e) {
        // The typed path may not exist yet — drop back to root once.
        if (
          e instanceof TestConnectionError &&
          e.kind === 'not_found' &&
          p !== '/'
        ) {
          await load('/');
          return;
        }
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [baseUrl, password],
  );

  // Re-list from the initial path each time the browser opens. Intentionally
  // keyed on `visible` only so navigation inside the browser isn't reset by
  // unrelated re-renders.
  useEffect(() => {
    if (visible) load(initialPath || '/');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const atRoot = path === '/';
  const text = Colors[scheme].text;
  const icon = Colors[scheme].icon;
  const tint = Colors[scheme].tint;

  const onUse = () => {
    onSelect(path);
    onClose();
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}>
      <ThemedView style={[styles.container, { paddingTop: insets.top }]}>
        <View style={[styles.header, { borderBottomColor: icon }]}>
          <Pressable
            onPress={() => load(parentPath(path))}
            disabled={atRoot || loading}
            hitSlop={8}
            style={styles.headerBtn}>
            <IconSymbol name="chevron.left" color={atRoot ? icon : text} size={26} />
          </Pressable>
          <ThemedText
            type="defaultSemiBold"
            numberOfLines={1}
            style={styles.headerPath}>
            {path}
          </ThemedText>
          <Pressable onPress={onClose} hitSlop={8} style={styles.headerBtn}>
            <IconSymbol name="xmark" color={text} size={22} />
          </Pressable>
        </View>

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator />
          </View>
        ) : error ? (
          <View style={styles.center}>
            <ThemedText style={styles.errorText}>{error}</ThemedText>
            <Pressable
              onPress={() => load(path)}
              style={({ pressed }) => [
                styles.retryBtn,
                { borderColor: tint, opacity: pressed ? 0.7 : 1 },
              ]}>
              <ThemedText style={{ color: tint, fontWeight: '600' }}>Retry</ThemedText>
            </Pressable>
          </View>
        ) : dirs.length === 0 ? (
          <View style={styles.center}>
            <ThemedText style={styles.hint}>No subfolders here.</ThemedText>
          </View>
        ) : (
          <FlatList
            data={dirs}
            keyExtractor={(item) => item}
            renderItem={({ item }) => (
              <Pressable
                onPress={() => load(childPath(path, item))}
                style={({ pressed }) => [
                  styles.row,
                  { borderBottomColor: icon, opacity: pressed ? 0.6 : 1 },
                ]}>
                <IconSymbol name="folder.fill" color={tint} size={22} />
                <ThemedText style={styles.rowText} numberOfLines={1}>
                  {item}
                </ThemedText>
                <IconSymbol name="chevron.right" color={icon} size={18} />
              </Pressable>
            )}
          />
        )}

        <View
          style={[
            styles.footer,
            { borderTopColor: icon, paddingBottom: insets.bottom + 12 },
          ]}>
          {!writable && !loading && !error ? (
            <ThemedText style={styles.hint}>
              Read-only — uploads here will fail.
            </ThemedText>
          ) : null}
          <Pressable
            onPress={onUse}
            disabled={!writable || loading}
            style={({ pressed }) => [
              styles.useBtn,
              {
                backgroundColor: writable && !loading ? tint : icon,
                opacity: pressed ? 0.85 : 1,
              },
            ]}>
            {!writable ? <IconSymbol name="lock.fill" color="#fff" size={18} /> : null}
            <ThemedText style={styles.useBtnText}>Use this folder</ThemedText>
          </Pressable>
        </View>
      </ThemedView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { padding: 4 },
  headerPath: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  errorText: { textAlign: 'center' },
  retryBtn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 20,
  },
  hint: { opacity: 0.6, fontSize: 13, textAlign: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowText: { flex: 1 },
  footer: {
    paddingTop: 12,
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  useBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 10,
    paddingVertical: 14,
  },
  useBtnText: { color: '#fff', fontWeight: '600', fontSize: 16 },
});
