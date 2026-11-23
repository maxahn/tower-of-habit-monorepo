import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, RefreshControl, ScrollView, View } from 'react-native';
import { Lobby } from '~/components/lobby';
import { TowerHome } from '~/components/tower-home';
import { usePeriodPreview, useTower } from '~/lib/hooks/use-towers';

export default function TowerDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, isLoading, refetch, isRefetching } = useTower(id, {
    refetchInterval: 10_000,
  });
  const isActive = data?.kind === 'active';
  const preview = usePeriodPreview(id, { enabled: isActive });

  if (isLoading || !data) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    );
  }

  const handleRefresh = () => {
    refetch();
    if (isActive) preview.refetch();
  };

  if (data.kind === 'lobby') {
    return (
      <ScrollView
        className="flex-1 bg-background"
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={handleRefresh} />}
      >
        <Lobby data={data} onLeave={() => router.back()} />
      </ScrollView>
    );
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      refreshControl={
        <RefreshControl
          refreshing={isRefetching || preview.isRefetching}
          onRefresh={handleRefresh}
        />
      }
      contentContainerClassName="px-4 py-4"
    >
      <TowerHome data={data} preview={preview.data} />
    </ScrollView>
  );
}
