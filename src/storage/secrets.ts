import * as SecureStore from 'expo-secure-store';

function key(serverId: number): string {
  // SecureStore restricts keys to [A-Za-z0-9._-]; ':' is rejected.
  return `server_${serverId}_pw`;
}

export async function getServerPassword(
  serverId: number,
): Promise<string | null> {
  return SecureStore.getItemAsync(key(serverId));
}

export async function setServerPassword(
  serverId: number,
  password: string,
): Promise<void> {
  await SecureStore.setItemAsync(key(serverId), password);
}

export async function deleteServerPassword(serverId: number): Promise<void> {
  await SecureStore.deleteItemAsync(key(serverId));
}
