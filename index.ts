/**
 * Custom bundle entry (package.json "main"). Import order is execution
 * order: the headless sync setup must fully evaluate before expo-router's
 * entry, and both run during plain bundle evaluation — which is all a
 * headless WorkManager cold start ever does (no surface, no route modules).
 * See src/sync/headless-entry.ts for the full story.
 */
import '@/src/sync/headless-entry';
import 'expo-router/entry';
