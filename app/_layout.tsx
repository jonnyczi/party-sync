import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import * as SQLite from 'expo-sqlite';
import { SQLiteProvider, useSQLiteContext } from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';
import { Suspense, useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import 'react-native-reanimated';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { reconcileInterruptedRuns } from '@/src/db/runs';
import { configureConnection, runMigrations } from '@/src/db/schema';
import { defaultProgressBus } from '@/src/sync/progress';
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
    // Heal runs orphaned in 'running' by a prior process that was killed
    // mid-sync. Guarded on the in-memory bus so it can never clobber a run
    // that's genuinely active in this process.
    if (defaultProgressBus.getSnapshot().activeRun === null) {
      reconcileInterruptedRuns(db).catch((e) => {
        console.warn('[copyparty] reconcileInterruptedRuns failed', e);
      });
    }
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
            <Stack.Screen
              name="server/[id]"
              options={{ title: 'Server', presentation: 'modal' }}
            />
            <Stack.Screen name="job/new" options={{ title: 'New job', presentation: 'modal' }} />
            <Stack.Screen name="job/[id]/index" options={{ title: 'Job' }} />
            <Stack.Screen
              name="job/[id]/edit"
              options={{ title: 'Edit job', presentation: 'modal' }}
            />
            <Stack.Screen name="run/[id]" options={{ title: 'Run' }} />
            <Stack.Screen name="settings" options={{ title: 'Settings' }} />
            <Stack.Screen
              name="backup"
              options={{ title: 'Backup & restore', presentation: 'modal' }}
            />
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
