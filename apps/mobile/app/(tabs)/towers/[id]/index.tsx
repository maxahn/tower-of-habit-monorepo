import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, RefreshControl, ScrollView, View } from 'react-native';
import { Lobby } from '~/components/lobby';
import { Text } from '~/components/ui/text';
import { useTower } from '~/lib/hooks/use-towers';

export default function TowerDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, isLoading, refetch, isRefetching } = useTower(id);

  if (isLoading || !data) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    );
  }

  if (data.kind === 'lobby') {
    return (
      <ScrollView
        className="flex-1 bg-background"
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
      >
        <Lobby data={data} onLeave={() => router.back()} />
      </ScrollView>
    );
  }

  // Active tower — placeholder for 5.7
  return (
    <ScrollView
      className="flex-1 bg-background"
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
      contentContainerClassName="px-4 pt-4"
    >
      <Text variant="h3">{data.tower.name}</Text>
      <Text variant="muted" className="mt-2">
        Active tower · Height {data.tower.height} · Streak {data.tower.currentStreak}
      </Text>
    </ScrollView>
  );
}
