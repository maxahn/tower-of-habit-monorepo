import { useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, FlatList, View } from 'react-native';
import type { BaseBlockResponse } from '@tower-of-habit/shared';
import { CurrentRunCard, StrataBlock } from '~/components/strata-block';
import { Text } from '~/components/ui/text';
import { useTower } from '~/lib/hooks/use-towers';

export default function HistoryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, isLoading, refetch, isRefetching } = useTower(id);

  if (isLoading || !data || data.kind !== 'active') {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    );
  }

  const blocksNewestFirst = [...data.blocks].reverse();
  const hasBlocks = blocksNewestFirst.length > 0;

  const renderItem = ({ item }: { item: BaseBlockResponse }) => (
    <View className="px-4 pb-2">
      <StrataBlock block={item} />
    </View>
  );

  const header = (
    <View className="px-4 pb-2 pt-4">
      <CurrentRunCard currentStreak={data.tower.currentStreak} memberCount={data.members.length} />
    </View>
  );

  if (!hasBlocks) {
    return (
      <View className="flex-1 bg-background px-4 pt-4">
        {header}
        <View className="mt-8 items-center rounded-xl border border-dashed border-border bg-card/50 px-6 py-8">
          <Text className="text-3xl">🧱</Text>
          <Text className="mt-2 text-center text-sm font-medium text-foreground">
            First attempt
          </Text>
          <Text variant="muted" className="mt-1 text-center">
            This is your tower's first run. Base blocks appear here after a collapse and rebuild.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <FlatList
      className="flex-1 bg-background"
      data={blocksNewestFirst}
      keyExtractor={(item) => item.id}
      renderItem={renderItem}
      ListHeaderComponent={header}
      onRefresh={refetch}
      refreshing={isRefetching}
    />
  );
}
