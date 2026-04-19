import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { SQLiteProvider } from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';
import { Suspense } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import 'react-native-reanimated';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { runMigrations } from '@/src/db/schema';

export const unstable_settings = {
  anchor: '(tabs)',
};

const DB_NAME = 'copyparty-client.db';

function LoadingScreen() {
  return (
    <View style={styles.loading}>
      <ActivityIndicator />
    </View>
  );
}

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Suspense fallback={<LoadingScreen />}>
        <SQLiteProvider databaseName={DB_NAME} onInit={runMigrations} useSuspense>
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
