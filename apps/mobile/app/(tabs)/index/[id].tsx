import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Alert, FlatList, Pressable, View } from 'react-native';
import { Text } from '~/components/ui/text';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { useArchiveHabit, useHabit, useHabitEntries } from '~/lib/hooks/use-habits';
import type { EntryResponse } from '@tower-of-habit/shared';

const TYPE_LABELS: Record<string, string> = {
  binary: 'Binary',
  numeric: 'Numeric',
  tiered: 'Tiered',
};

function periodLabel(periodUnit: string, periodLength: number) {
  if (periodLength === 1) return periodUnit === 'day' ? 'Daily' : 'Weekly';
  return `Every ${periodLength} ${periodUnit}s`;
}

function EntryRow({ entry }: { entry: EntryResponse }) {
  const date = new Date(entry.loggedAt);
  const dateStr = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const timeStr = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });

  return (
    <View className="mx-4 mb-2 flex-row items-center justify-between rounded-lg border border-border bg-card px-4 py-3">
      <View className="gap-0.5">
        <Text className="text-sm font-medium text-foreground">{entry.localDate}</Text>
        <Text className="text-xs text-muted-foreground">
          {dateStr} at {timeStr}
        </Text>
      </View>
      <View className="items-end gap-0.5">
        {entry.numericValue != null && (
          <Text className="text-sm font-semibold text-foreground">{entry.numericValue}</Text>
        )}
        <Text className="text-xs text-muted-foreground">
          Tier {entry.tierReached}
          {entry.countsTowardQuota ? '' : ' · Not counted'}
        </Text>
      </View>
    </View>
  );
}

export default function HabitDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, isLoading } = useHabit(id!);
  const {
    data: entriesData,
    isLoading: entriesLoading,
    refetch,
    isRefetching,
  } = useHabitEntries(id!);
  const archiveHabit = useArchiveHabit(id!);

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    );
  }

  if (!data) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <Text variant="muted">Habit not found</Text>
      </View>
    );
  }

  const { habit, tiers, currentStreak, tower } = data;
  const isArchived = habit.lifecycle === 'archived';

  function handleArchive() {
    Alert.alert('Archive Habit', `Are you sure you want to archive "${habit.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Archive',
        style: 'destructive',
        onPress: () =>
          archiveHabit.mutate(undefined, {
            onSuccess: () => router.back(),
            onError: (err) => Alert.alert('Error', err.message),
          }),
      },
    ]);
  }

  const entries = entriesData?.entries ?? [];

  return (
    <View className="flex-1 bg-background">
      <FlatList
        data={entries}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <EntryRow entry={item} />}
        onRefresh={refetch}
        refreshing={isRefetching}
        contentContainerStyle={{ paddingBottom: 24 }}
        ListHeaderComponent={
          <View className="gap-4 px-4 pb-4 pt-4">
            {/* Streak */}
            <Card>
              <CardContent className="items-center py-4">
                <Text className="text-4xl font-bold text-primary">{currentStreak}</Text>
                <Text className="text-sm text-muted-foreground">Current Streak</Text>
              </CardContent>
            </Card>

            {/* Info */}
            <Card>
              <CardHeader>
                <View className="flex-row items-center gap-2">
                  <View className="rounded bg-primary/10 px-2 py-0.5">
                    <Text className="text-xs font-medium text-primary">
                      {TYPE_LABELS[habit.type] ?? habit.type}
                    </Text>
                  </View>
                  {isArchived && (
                    <View className="rounded bg-destructive/10 px-2 py-0.5">
                      <Text className="text-xs font-medium text-destructive">Archived</Text>
                    </View>
                  )}
                </View>
              </CardHeader>
              <CardContent>
                <View className="gap-2">
                  <View className="flex-row justify-between">
                    <Text className="text-sm text-muted-foreground">Period</Text>
                    <Text className="text-sm text-foreground">
                      {periodLabel(habit.periodUnit, habit.periodLength)}
                    </Text>
                  </View>
                  <View className="flex-row justify-between">
                    <Text className="text-sm text-muted-foreground">Quota</Text>
                    <Text className="text-sm text-foreground">{habit.quota}</Text>
                  </View>
                  {habit.unit && (
                    <View className="flex-row justify-between">
                      <Text className="text-sm text-muted-foreground">Unit</Text>
                      <Text className="text-sm text-foreground">{habit.unit}</Text>
                    </View>
                  )}
                </View>
              </CardContent>
            </Card>

            {/* Tiers (non-binary) */}
            {tiers.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Tiers</CardTitle>
                </CardHeader>
                <CardContent>
                  <View className="gap-1.5">
                    {tiers.map((tier) => (
                      <View key={tier.id} className="flex-row items-center justify-between">
                        <Text className="text-sm text-foreground">
                          {tier.tierIndex}. {tier.label}
                        </Text>
                        {tier.thresholdValue != null && (
                          <Text className="text-sm text-muted-foreground">
                            ≥ {tier.thresholdValue}
                          </Text>
                        )}
                      </View>
                    ))}
                  </View>
                </CardContent>
              </Card>
            )}

            {/* Tower association */}
            {tower && (
              <Card>
                <CardHeader>
                  <CardTitle>Tower</CardTitle>
                </CardHeader>
                <CardContent>
                  <View className="gap-1">
                    <Text className="text-sm font-medium text-foreground">{tower.name}</Text>
                    <Text className="text-xs text-muted-foreground">
                      {tower.lifecycle} · {tower.membershipState}
                    </Text>
                  </View>
                </CardContent>
              </Card>
            )}

            {/* Actions */}
            <View className="flex-row gap-3">
              <Pressable
                onPress={() =>
                  router.push({ pathname: '/index/edit' as const, params: { id: habit.id } })
                }
                className="flex-1 items-center rounded-lg border border-border bg-card py-3"
              >
                <Text className="text-sm font-medium text-foreground">Edit</Text>
              </Pressable>
              {!isArchived && (
                <Pressable
                  onPress={handleArchive}
                  disabled={archiveHabit.isPending}
                  className="flex-1 items-center rounded-lg border border-destructive/30 bg-card py-3"
                >
                  <Text className="text-sm font-medium text-destructive">
                    {archiveHabit.isPending ? 'Archiving...' : 'Archive'}
                  </Text>
                </Pressable>
              )}
            </View>

            {/* Entry history header */}
            <Text variant="h4" className="mt-2">
              Entry History
            </Text>
            {entriesLoading && <ActivityIndicator className="mt-4" />}
            {!entriesLoading && entries.length === 0 && (
              <Text variant="muted" className="mt-2 text-center">
                No entries yet. Log your first entry to start your streak.
              </Text>
            )}
          </View>
        }
      />
    </View>
  );
}
