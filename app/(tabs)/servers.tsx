import { useFocusEffect, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { deleteServer, listServers } from '@/src/db/servers';
import type { ServerRow } from '@/src/db/types';
import { deleteServerPassword } from '@/src/storage/secrets';

export default function ServersScreen() {
  const db = useSQLiteContext();
  const router = useRouter();
  const scheme = useColorScheme() ?? 'light';
  const insets = useSafeAreaInsets();
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setServers(await listServers(db));
  }, [db]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    refresh()
      .catch((e) => console.warn('servers refresh failed', e))
      .finally(() => setRefreshing(false));
  }, [refresh]);

  useFocusEffect(
    useCallback(() => {
      refresh().catch((e) => console.warn('servers refresh failed', e));
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
    <ThemedView style={[styles.container, { paddingTop: insets.top + 8 }]}>
      <View style={styles.header}>
        <ThemedText type="title">Servers</ThemedText>
        <Pressable
          onPress={() => router.push('/server/new')}
          style={({ pressed }) => [
            styles.addBtn,
            { backgroundColor: Colors[scheme].accent, opacity: pressed ? 0.7 : 1 },
          ]}
          accessibilityLabel="Add server">
          <IconSymbol name="plus" color={Colors[scheme].onAccent} size={20} />
          <ThemedText style={[styles.addBtnText, { color: Colors[scheme].onAccent }]}>
            Add
          </ThemedText>
        </Pressable>
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
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={Colors[scheme].icon}
            />
          }
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push(`/server/${item.id}`)}
              onLongPress={() => confirmDelete(item)}
              style={({ pressed }) => [
                styles.row,
                { borderBottomColor: Colors[scheme].border, opacity: pressed ? 0.6 : 1 },
              ]}>
              <View style={styles.rowMain}>
                <ThemedText type="defaultSemiBold">{item.name}</ThemedText>
                <ThemedText style={styles.rowSub}>{item.base_url}</ThemedText>
              </View>
              <IconSymbol name="chevron.right" color={Colors[scheme].icon} size={20} />
            </Pressable>
          )}
        />
      )}
    </ThemedView>
  );
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
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  addBtnText: { fontWeight: '600' },
  list: { paddingHorizontal: 16, paddingBottom: 24 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  rowMain: { flex: 1, gap: 2 },
  rowSub: { opacity: 0.7, fontSize: 13 },
  empty: { paddingHorizontal: 24, paddingTop: 48, gap: 8 },
  emptyHint: { opacity: 0.7 },
});
