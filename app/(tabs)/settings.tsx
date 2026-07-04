import { useFocusEffect, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { deleteServer, listServers } from '@/src/db/servers';
import type { ServerRow } from '@/src/db/types';
import { deleteServerPassword } from '@/src/storage/secrets';

export default function SettingsScreen() {
  const db = useSQLiteContext();
  const router = useRouter();
  const scheme = useColorScheme() ?? 'light';
  const [servers, setServers] = useState<ServerRow[]>([]);

  const refresh = useCallback(() => {
    listServers(db).then(setServers);
  }, [db]);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  const confirmDelete = (row: ServerRow) => {
    Alert.alert(
      `Delete ${row.name}?`,
      'This removes the server and any jobs that use it.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await deleteServer(db, row.id);
            await deleteServerPassword(row.id).catch(() => {
              // secret may not exist; ignore
            });
            refresh();
          },
        },
      ],
    );
  };

  return (
    <ThemedView style={styles.container}>
      <View style={styles.header}>
        <ThemedText type="title">Servers</ThemedText>
        <View style={styles.headerActions}>
          <Pressable
            onPress={() => router.push('/backup')}
            style={({ pressed }) => [
              styles.iconBtn,
              { borderColor: Colors[scheme].tint, opacity: pressed ? 0.7 : 1 },
            ]}
            accessibilityLabel="Backup and restore">
            <IconSymbol name="arrow.up.arrow.down" color={Colors[scheme].tint} size={20} />
          </Pressable>
          <Pressable
            onPress={() => router.push('/server/new')}
            style={({ pressed }) => [
              styles.addBtn,
              { backgroundColor: Colors[scheme].tint, opacity: pressed ? 0.7 : 1 },
            ]}
            accessibilityLabel="Add server">
            <IconSymbol name="plus" color="#fff" size={20} />
            <ThemedText style={styles.addBtnText}>Add</ThemedText>
          </Pressable>
        </View>
      </View>

      {servers.length === 0 ? (
        <View style={styles.empty}>
          <ThemedText type="subtitle">No servers yet</ThemedText>
          <ThemedText style={styles.emptyHint}>
            Add a copyparty server to start configuring sync jobs.
          </ThemedText>
        </View>
      ) : (
        <FlatList
          data={servers}
          keyExtractor={(s) => String(s.id)}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push(`/server/${item.id}`)}
              onLongPress={() => confirmDelete(item)}
              style={({ pressed }) => [
                styles.row,
                { opacity: pressed ? 0.6 : 1 },
              ]}>
              <View style={styles.rowMain}>
                <ThemedText type="defaultSemiBold">{item.name}</ThemedText>
                <ThemedText style={styles.rowSub}>{item.base_url}</ThemedText>
              </View>
              <Pressable
                onPress={() => confirmDelete(item)}
                hitSlop={12}
                accessibilityLabel={`Delete ${item.name}`}>
                <IconSymbol
                  name="trash"
                  color={Colors[scheme].icon}
                  size={22}
                />
              </Pressable>
            </Pressable>
          )}
        />
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 56 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  iconBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  addBtnText: { color: '#fff', fontWeight: '600' },
  list: { paddingHorizontal: 16, paddingBottom: 24 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#8882',
    gap: 12,
  },
  rowMain: { flex: 1, gap: 2 },
  rowSub: { opacity: 0.7, fontSize: 13 },
  empty: { paddingHorizontal: 24, paddingTop: 48, gap: 8 },
  emptyHint: { opacity: 0.7 },
});
