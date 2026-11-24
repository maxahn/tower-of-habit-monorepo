import { Link } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, View } from 'react-native';
import { EmptyState } from '~/components/empty-state';
import { Button } from '~/components/ui/button';
import { Text } from '~/components/ui/text';
import { useHabits } from '~/lib/hooks/use-habits';
import type { HabitResponse } from '@tower-of-habit/shared';

const TYPE_LABELS: Record<string, string> = {
  binary: 'Binary',
  numeric: 'Numeric',
  tiered: 'Tiered',
};

function periodLabel(h: HabitResponse) {
  if (h.periodLength === 1) return h.periodUnit === 'day' ? 'Daily' : 'Weekly';
  return `Every ${h.periodLength} ${h.periodUnit}s`;
}

function sortHabits(habits: HabitResponse[]): HabitResponse[] {
  return [...habits].sort((a, b) => {
    const aArchived = a.lifecycle === 'archived' ? 1 : 0;
    const bArchived = b.lifecycle === 'archived' ? 1 : 0;
    if (aArchived !== bArchived) return aArchived - bArchived;
    return a.name.localeCompare(b.name);
  });
}

function HabitRow({ habit }: { habit: HabitResponse }) {
  const isArchived = habit.lifecycle === 'archived';

  return (
    <Link href={`/index/${habit.id}` as const} asChild>
      <Pressable
        className={`mx-4 mb-2 rounded-xl border border-border bg-card px-4 py-3 ${isArchived ? 'opacity-50' : ''}`}
      >
        <View className="flex-row items-center justify-between">
          <View className="flex-1 gap-1">
            <View className="flex-row items-center gap-2">
              <Text className="text-base font-semibold text-foreground">{habit.name}</Text>
              {isArchived && (
                <View className="rounded bg-muted px-1.5 py-0.5">
                  <Text className="text-xs text-muted-foreground">Archived</Text>
                </View>
              )}
            </View>
            <View className="flex-row items-center gap-2">
              <View className="rounded bg-primary/10 px-1.5 py-0.5">
                <Text className="text-xs font-medium text-primary">
                  {TYPE_LABELS[habit.type] ?? habit.type}
                </Text>
              </View>
              <Text className="text-xs text-muted-foreground">
                {periodLabel(habit)} · Quota {habit.quota}
              </Text>
            </View>
          </View>
          <Text className="text-muted-foreground">›</Text>
        </View>
      </Pressable>
    </Link>
  );
}

export default function HabitsScreen() {
  const { data, isLoading, refetch, isRefetching } = useHabits();
  const habits = data?.habits ? sortHabits(data.habits) : [];

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    );
  }

  if (habits.length === 0) {
    return (
      <View className="flex-1 bg-background">
        <EmptyState
          icon="🌱"
          title="Start with a habit"
          description="Habits are the building blocks of towers. Create one to track something you do regularly — like running, reading, or meditating."
        >
          <Link href="/index/create" asChild>
            <Button className="w-full max-w-xs">
              <Text>Create your first habit</Text>
            </Button>
          </Link>
        </EmptyState>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <FlatList
        data={habits}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <HabitRow habit={item} />}
        contentContainerStyle={{ paddingTop: 12, paddingBottom: 24 }}
        onRefresh={() => {
          refetch();
        }}
        refreshing={isRefetching}
        ListHeaderComponent={
          <View className="mb-3 flex-row items-center justify-between px-4">
            <Text variant="h3">Habits</Text>
            <Link href="/index/create" asChild>
              <Button size="sm" variant="outline">
                <Text>+ New</Text>
              </Button>
            </Link>
          </View>
        }
      />
    </View>
  );
}
