import { Link, router } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, View } from 'react-native';
import type { TowerStatus } from '@tower-of-habit/shared';
import { EmptyState } from '~/components/empty-state';
import { Button } from '~/components/ui/button';
import { Text } from '~/components/ui/text';
import { useHabits } from '~/lib/hooks/use-habits';
import { useTowers } from '~/lib/hooks/use-towers';

const LIFECYCLE_BADGE: Record<TowerStatus, { bg: string; text: string }> = {
  draft: { bg: 'bg-blue-500/15', text: 'text-blue-600' },
  active: { bg: 'bg-green-500/15', text: 'text-green-600' },
  paused: { bg: 'bg-amber-500/15', text: 'text-amber-600' },
  archived: { bg: 'bg-muted', text: 'text-muted-foreground' },
};

export default function TowersListScreen() {
  const { data, isLoading, refetch, isRefetching } = useTowers();
  const { data: habitsData } = useHabits();
  const towers = data?.towers ?? [];
  const hasHabits = (habitsData?.habits?.length ?? 0) > 0;

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
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={() => {
              refetch();
            }}
          />
        }
        ListEmptyComponent={
          hasHabits ? (
            <EmptyState
              icon="🏗️"
              title="Build a tower"
              description="Towers are group streaks. Create one and invite friends, or join an existing tower with a code."
            >
              <Button onPress={() => router.push('./create' as never)} className="w-full max-w-xs">
                <Text>Create a tower</Text>
              </Button>
              <Button
                variant="outline"
                onPress={() => router.push('./join' as never)}
                className="w-full max-w-xs"
              >
                <Text>Join with a code</Text>
              </Button>
            </EmptyState>
          ) : (
            <EmptyState
              icon="🏗️"
              title="Towers need habits"
              description="Each tower member brings a habit. Create a habit first on the Habits tab, then come back to start or join a tower."
            >
              <Link href="/(tabs)/index/create" asChild>
                <Button className="w-full max-w-xs">
                  <Text>Create a habit</Text>
                </Button>
              </Link>
            </EmptyState>
          )
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push(`./${item.tower.id}` as never)}
            className="mb-3 rounded-xl border border-border bg-card p-4"
          >
            <View className="flex-row items-center justify-between">
              <Text className="text-lg font-semibold text-foreground">{item.tower.name}</Text>
              <View
                className={`rounded-full px-2.5 py-0.5 ${(LIFECYCLE_BADGE[item.tower.lifecycle as TowerStatus] ?? LIFECYCLE_BADGE.archived).bg}`}
              >
                <Text
                  className={`text-xs ${(LIFECYCLE_BADGE[item.tower.lifecycle as TowerStatus] ?? LIFECYCLE_BADGE.archived).text}`}
                >
                  {item.tower.lifecycle}
                </Text>
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
        <View className="absolute bottom-8 right-6 flex-row gap-3">
          <Button
            variant="outline"
            onPress={() => router.push('./join' as never)}
            className="rounded-full px-5"
          >
            <Text>Join</Text>
          </Button>
          <Button onPress={() => router.push('./create' as never)} className="rounded-full px-5">
            <Text>+ New</Text>
          </Button>
        </View>
      )}
    </View>
  );
}
