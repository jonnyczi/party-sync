import { useEffect, useState } from 'react';
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
import { listMediaAlbums, type AlbumOption } from '@/src/media/albums';
import { ALBUM_PREFIX, MEDIA_SOURCE_ALL } from '@/src/sync/walker/media';

type Props = {
  visible: boolean;
  /** Current source_uri sentinel ('all' or 'album:<id>'). */
  selected: string;
  /** Hands back the chosen sentinel and closes. */
  onSelect: (sentinel: string) => void;
  onClose: () => void;
};

type Row = { sentinel: string; title: string };

const ALL_ROW: Row = { sentinel: MEDIA_SOURCE_ALL, title: 'All photos & videos' };

/**
 * Camera-roll scope picker, presented as an in-screen RN Modal so it overlays
 * the (router-modal) job editor without unmounting it. Lists "All photos &
 * videos" plus each device album; tapping a row selects it and closes. Mirrors
 * {@link RemotePathBrowser}'s modal shell.
 */
export function AlbumPicker({ visible, selected, onSelect, onClose }: Props) {
  const scheme = useColorScheme() ?? 'light';
  const insets = useSafeAreaInsets();
  const [albums, setAlbums] = useState<AlbumOption[]>([]);
  const [loading, setLoading] = useState(false);
  // null = ok; 'denied' = no permission; string = unexpected failure.
  const [error, setError] = useState<'denied' | string | null>(null);

  const text = Colors[scheme].text;
  const icon = Colors[scheme].icon;
  const tint = Colors[scheme].tint;

  // Re-list each time the picker opens. Prompts for permission on open (this is
  // a deliberate user action), unlike the editor's passive label resolution.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    listMediaAlbums({ prompt: true })
      .then((found) => {
        if (cancelled) return;
        setAlbums(found);
        // listMediaAlbums returns [] both for "no albums" and "permission
        // denied"; treat an empty result as a denial prompt since a device
        // with photos always has at least one album.
        setError(found.length === 0 ? 'denied' : null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const rows: Row[] = [
    ALL_ROW,
    ...albums.map((a) => ({ sentinel: `${ALBUM_PREFIX}${a.id}`, title: a.title })),
  ];

  const choose = (sentinel: string) => {
    onSelect(sentinel);
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <ThemedView style={[styles.container, { paddingTop: insets.top }]}>
        <View style={[styles.header, { borderBottomColor: icon }]}>
          <ThemedText type="defaultSemiBold" style={styles.headerTitle}>
            Camera roll scope
          </ThemedText>
          <Pressable onPress={onClose} hitSlop={8} style={styles.headerBtn}>
            <IconSymbol name="xmark" color={text} size={22} />
          </Pressable>
        </View>

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator />
          </View>
        ) : error === 'denied' ? (
          <View style={styles.center}>
            <ThemedText style={styles.hint}>
              Camera-roll access is needed to list albums. Grant Photos & Videos
              in system settings, then reopen this picker.
            </ThemedText>
          </View>
        ) : error ? (
          <View style={styles.center}>
            <ThemedText style={styles.errorText}>{error}</ThemedText>
          </View>
        ) : (
          <FlatList
            data={rows}
            keyExtractor={(item) => item.sentinel}
            contentContainerStyle={{ paddingBottom: insets.bottom + 12 }}
            renderItem={({ item }) => {
              const isSelected = item.sentinel === selected;
              return (
                <Pressable
                  onPress={() => choose(item.sentinel)}
                  style={({ pressed }) => [
                    styles.row,
                    { borderBottomColor: icon, opacity: pressed ? 0.6 : 1 },
                  ]}>
                  <IconSymbol name="photo.on.rectangle" color={tint} size={22} />
                  <ThemedText style={styles.rowText} numberOfLines={1}>
                    {item.title}
                  </ThemedText>
                  {isSelected ? (
                    <IconSymbol name="checkmark.circle.fill" color={tint} size={22} />
                  ) : null}
                </Pressable>
              );
            }}
          />
        )}
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
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { flex: 1 },
  headerBtn: { padding: 4 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  errorText: { textAlign: 'center' },
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
});
