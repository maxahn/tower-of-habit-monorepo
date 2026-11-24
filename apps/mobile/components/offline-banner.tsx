import { View } from 'react-native';
import { useIsMutating } from '@tanstack/react-query';
import { Text } from '~/components/ui/text';
import { useIsOnline } from '~/lib/hooks/use-online';

export function OfflineBanner() {
  const isOnline = useIsOnline();
  const pendingCount = useIsMutating();

  if (isOnline) return null;

  return (
    <View className="bg-amber-500 px-4 py-2 dark:bg-amber-600">
      <Text className="text-center text-sm font-medium text-white">
        You're offline
        {pendingCount > 0
          ? ` — ${pendingCount} pending ${pendingCount === 1 ? 'change' : 'changes'}`
          : ' — changes will sync when you reconnect'}
      </Text>
    </View>
  );
}
