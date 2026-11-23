import { useCallback, useRef, useState } from 'react';
import { Alert, Pressable, TextInput, View } from 'react-native';
import type { HabitResponse, HabitTierResponse, LogEntryRequest } from '@tower-of-habit/shared';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Text } from '~/components/ui/text';
import { Card, CardContent } from '~/components/ui/card';
import { useLogEntry } from '~/lib/hooks/use-entries';

type Props = {
  habit: HabitResponse;
  tiers: HabitTierResponse[];
  towerId?: string | null;
};

export function LogEntry({ habit, tiers, towerId }: Props) {
  const logEntry = useLogEntry(habit.id, towerId);
  const [cooldown, setCooldown] = useState(false);
  const [numericText, setNumericText] = useState('');
  const numericRef = useRef<TextInput>(null);

  const disabled = logEntry.isPending || cooldown;

  const submit = useCallback(
    (req: LogEntryRequest) => {
      if (disabled) return;
      logEntry.mutate(req, {
        onSuccess: () => {
          setCooldown(true);
          setNumericText('');
          setTimeout(() => setCooldown(false), 1000);
        },
        onError: (err) => Alert.alert('Error', err.message),
      });
    },
    [disabled, logEntry]
  );

  if (habit.type === 'binary') {
    return (
      <Card>
        <CardContent className="py-4">
          <Button
            size="lg"
            disabled={disabled}
            onPress={() =>
              submit({
                habitId: habit.id,
                tierReached: 0,
                clientEntryId: crypto.randomUUID(),
              })
            }
            className="w-full"
          >
            <Text>{disabled ? 'Logged!' : 'Done'}</Text>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (habit.type === 'numeric') {
    const threshold = tiers[0]?.thresholdValue;
    return (
      <Card>
        <CardContent className="gap-3 py-4">
          {threshold != null && (
            <Text className="text-center text-sm text-muted-foreground">
              Log ≥ {threshold} {habit.unit ?? ''} to qualify
            </Text>
          )}
          <View className="flex-row gap-3">
            <Input
              ref={numericRef}
              className="flex-1"
              placeholder={habit.unit ?? 'Value'}
              keyboardType="numeric"
              value={numericText}
              onChangeText={setNumericText}
              returnKeyType="done"
              onSubmitEditing={() => {
                const val = Number(numericText);
                if (!Number.isFinite(val)) return;
                submit({
                  habitId: habit.id,
                  numericValue: val,
                  clientEntryId: crypto.randomUUID(),
                });
              }}
            />
            <Button
              disabled={
                disabled || numericText.trim() === '' || !Number.isFinite(Number(numericText))
              }
              onPress={() => {
                const val = Number(numericText);
                if (!Number.isFinite(val)) return;
                submit({
                  habitId: habit.id,
                  numericValue: val,
                  clientEntryId: crypto.randomUUID(),
                });
              }}
            >
              <Text>{disabled ? 'Logged!' : 'Log'}</Text>
            </Button>
          </View>
        </CardContent>
      </Card>
    );
  }

  // Tiered
  const sortedTiers = [...tiers].sort((a, b) => a.tierIndex - b.tierIndex);
  return (
    <Card>
      <CardContent className="gap-2 py-4">
        <Text className="text-center text-sm text-muted-foreground">Select your tier</Text>
        {sortedTiers.map((tier) => (
          <Pressable
            key={tier.id}
            disabled={disabled}
            onPress={() =>
              submit({
                habitId: habit.id,
                tierReached: tier.tierIndex,
                numericValue: tier.thresholdValue ?? undefined,
                clientEntryId: crypto.randomUUID(),
              })
            }
            className="flex-row items-center justify-between rounded-lg border border-border bg-card px-4 py-3 active:bg-accent"
          >
            <View className="flex-row items-center gap-2">
              <View className="h-6 w-6 items-center justify-center rounded-full bg-primary/10">
                <Text className="text-xs font-bold text-primary">{tier.tierIndex}</Text>
              </View>
              <Text className="text-sm font-medium text-foreground">{tier.label}</Text>
            </View>
            {tier.thresholdValue != null && (
              <Text className="text-sm text-muted-foreground">≥ {tier.thresholdValue}</Text>
            )}
          </Pressable>
        ))}
      </CardContent>
    </Card>
  );
}
