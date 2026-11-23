import { router } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, View } from 'react-native';
import { Button } from '~/components/ui/button';
import { Text } from '~/components/ui/text';
import { useTowers } from '~/lib/hooks/use-towers';

export default function TowersListScreen() {
  const { data, isLoading, refetch, isRefetching } = useTowers();
  const towers = data?.towers ?? [];

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <FlatList
        data={towers}
        keyExtractor={(item) => item.tower.id}
        contentContainerClassName="px-4 pt-4 pb-24"
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
        ListEmptyComponent={
          <View className="flex-1 items-center justify-center pt-24">
            <Text variant="h3">No towers yet</Text>
            <Text variant="muted" className="mt-2 text-center">
              Create a tower to build streaks with friends, or join one with a code.
            </Text>
            <Button onPress={() => router.push('./create' as never)} className="mt-6">
              <Text>Create Tower</Text>
            </Button>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push(`./${item.tower.id}` as never)}
            className="mb-3 rounded-xl border border-border bg-card p-4"
          >
            <View className="flex-row items-center justify-between">
              <Text className="text-lg font-semibold text-foreground">{item.tower.name}</Text>
              <View className="rounded-full bg-muted px-2.5 py-0.5">
                <Text className="text-xs text-muted-foreground">{item.tower.lifecycle}</Text>
              </View>
            </View>
            <View className="mt-2 flex-row gap-4">
              <Text className="text-sm text-muted-foreground">Height: {item.tower.height}</Text>
              <Text className="text-sm text-muted-foreground">
                Streak: {item.tower.currentStreak}
              </Text>
              <Text className="text-sm text-muted-foreground">
                {item.memberCount} member{item.memberCount !== 1 ? 's' : ''}
              </Text>
            </View>
          </Pressable>
        )}
      />

      {towers.length > 0 && (
        <View className="absolute bottom-8 right-6">
          <Button onPress={() => router.push('./create' as never)} className="rounded-full px-5">
            <Text>+ New Tower</Text>
          </Button>
        </View>
      )}
    </View>
  );
}
