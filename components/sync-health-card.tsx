import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

/**
 * Dashboard warning card, shown only when periodic sync is enabled on some
 * job AND a health probe found a blocked-level issue (battery optimization,
 * background restriction). Warn-level items stay in the checklist screen so
 * the dashboard doesn't permanently nag e.g. every Samsung owner.
 */
export function SyncHealthCard({
  blockedCount,
  onOpen,
}: {
  blockedCount: number;
  onOpen: () => void;
}) {
  const scheme = useColorScheme() ?? 'light';
  const c = Colors[scheme];
  return (
    <Pressable
      onPress={onOpen}
      accessibilityLabel="Review background sync settings"
      style={({ pressed }) => [
        styles.card,
        { borderColor: c.danger, opacity: pressed ? 0.7 : 1 },
      ]}>
      <IconSymbol name="exclamationmark.triangle.fill" color={c.danger} size={22} />
      <View style={styles.body}>
        <ThemedText type="defaultSemiBold">Background sync is blocked</ThemedText>
        <ThemedText style={styles.sub}>
          {blockedCount === 1 ? 'A device setting prevents' : `${blockedCount} device settings prevent`}{' '}
          scheduled syncs from running — tap to review.
        </ThemedText>
      </View>
      <IconSymbol name="chevron.right" color={c.icon} size={18} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  body: { flex: 1, gap: 2 },
  sub: { opacity: 0.7, fontSize: 13 },
});
