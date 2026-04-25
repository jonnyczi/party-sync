import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import * as SQLite from 'expo-sqlite';
import { SQLiteProvider, useSQLiteContext } from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';
import { Suspense, useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import 'react-native-reanimated';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { configureConnection, runMigrations } from '@/src/db/schema';
import {
  definePeriodicTask,
  syncPeriodicRegistration,
} from '@/src/sync/scheduler-register';

export const unstable_settings = {
  anchor: '(tabs)',
};

const DB_NAME = 'copyparty-client.db';

// The background task must be defined at module load — TaskManager needs
// it registered before any periodic invocation can dispatch, and
// WorkManager can fire while no React tree is mounted. Each invocation
// opens its own DB handle since the in-process SQLiteProvider may not be
// alive.
definePeriodicTask(async () => {
  const db = await SQLite.openDatabaseAsync(DB_NAME);
  await configureConnection(db);
  return db;
});

function LoadingScreen() {
  return (
    <View style={styles.loading}>
      <ActivityIndicator />
    </View>
  );
}

function PeriodicRegistrar() {
  const db = useSQLiteContext();
  useEffect(() => {
    syncPeriodicRegistration(db).catch((e) => {
      console.warn('[copyparty] syncPeriodicRegistration failed', e);
    });
  }, [db]);
  return null;
}

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Suspense fallback={<LoadingScreen />}>
        <SQLiteProvider databaseName={DB_NAME} onInit={runMigrations} useSuspense>
          <PeriodicRegistrar />
          <Stack>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
            <Stack.Screen
              name="server/[id]"
              options={{ title: 'Server', presentation: 'modal' }}
            />
            <Stack.Screen
              name="job/[id]"
              options={{ title: 'Job', presentation: 'modal' }}
            />
            <Stack.Screen name="run/[id]" options={{ title: 'Run' }} />
          </Stack>
        </SQLiteProvider>
      </Suspense>
      <StatusBar style="auto" />
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
