import NetInfo from '@react-native-community/netinfo';
import { onlineManager } from '@tanstack/react-query';

export function setupOnlineManager(): () => void {
  return NetInfo.addEventListener((state) => {
    onlineManager.setOnline(state.isConnected !== false);
  });
}
