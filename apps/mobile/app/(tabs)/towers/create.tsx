import { zodResolver } from '@hookform/resolvers/zod';
import { DEFAULT_WOBBLE_LEAD_MINUTES, DEFAULT_NUDGE_LEAD_MINUTES } from '@tower-of-habit/shared';
import type { CreateTowerRequest } from '@tower-of-habit/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  View,
} from 'react-native';
import { z } from 'zod';
import { DeadlinePicker } from '~/components/deadline-picker';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Text } from '~/components/ui/text';
import { useCreateTower, useEligibleHabits } from '~/lib/hooks/use-towers';

const formSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  periodUnit: z.enum(['day', 'week']),
  periodLength: z.string(),
  quota: z.string(),
  deadlineTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Invalid time'),
  graceWindowMinutes: z.string(),
  weekResetDay: z.string().optional(),
});

type FormValues = z.infer<typeof formSchema>;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function buildRequest(
  values: FormValues,
  habitId: string,
  timezone: string
): CreateTowerRequest | { error: string } {
  const periodLength = parseInt(values.periodLength, 10);
  const quota = parseInt(values.quota, 10);
  const graceWindowMinutes = parseInt(values.graceWindowMinutes, 10);

  if (isNaN(periodLength) || periodLength < 1) return { error: 'Period length must be at least 1' };
  if (isNaN(quota) || quota < 1) return { error: 'Quota must be at least 1' };
  if (quota > periodLength) return { error: 'Quota cannot exceed period length' };
  if (isNaN(graceWindowMinutes) || graceWindowMinutes < 0)
    return { error: 'Grace window must be 0 or more minutes' };

  const req: Record<string, unknown> = {
    name: values.name,
    habitId,
    deadlineTime: values.deadlineTime,
    timezone,
    periodUnit: values.periodUnit,
    periodLength,
    quota,
    graceWindowMinutes,
  };

  if (values.periodUnit === 'week') {
    const day = parseInt(values.weekResetDay ?? '', 10);
    if (isNaN(day) || day < 0 || day > 6) return { error: 'Weekly towers need a reset day' };
    req.weekResetDay = day;
  } else {
    req.weekResetDay = null;
  }

  return req as unknown as CreateTowerRequest;
}

export default function CreateTowerScreen() {
  const deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [selectedHabitId, setSelectedHabitId] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const createTower = useCreateTower();
  const { data: eligibleHabits, isLoading: habitsLoading } = useEligibleHabits();

  const {
    control,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '',
      periodUnit: 'day',
      periodLength: '1',
      quota: '1',
      deadlineTime: '22:00',
      graceWindowMinutes: '120',
      weekResetDay: '1',
    },
  });

  const periodUnit = watch('periodUnit');

  function onSubmit(values: FormValues) {
    if (!selectedHabitId) {
      Alert.alert('Select a habit', 'Pick a habit to bring into this tower.');
      return;
    }
    const result = buildRequest(values, selectedHabitId, deviceTimezone);
    if ('error' in result) {
      Alert.alert('Validation Error', result.error);
      return;
    }
    createTower.mutate(result, {
      onSuccess: (data) => {
        if (data && 'tower' in data) {
          router.replace(`./${data.tower.id}` as never);
        } else {
          router.back();
        }
      },
      onError: (err) => Alert.alert('Error', err.message),
    });
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="flex-1 bg-background"
    >
      <ScrollView className="flex-1 px-6 pt-6" keyboardShouldPersistTaps="handled">
        <View className="gap-5 pb-12">
          {/* Tower name */}
          <View className="gap-1">
            <Label>Tower name</Label>
            <Controller
              control={control}
              name="name"
              render={({ field: { onChange, onBlur, value } }) => (
                <Input
                  placeholder="e.g. Morning Crew"
                  value={value}
                  onChangeText={onChange}
                  onBlur={onBlur}
                  autoFocus
                />
              )}
            />
            {errors.name && <Text className="text-sm text-destructive">{errors.name.message}</Text>}
          </View>

          {/* Habit picker */}
          <View className="gap-2">
            <Label>Habit</Label>
            {habitsLoading ? (
              <ActivityIndicator />
            ) : !eligibleHabits || eligibleHabits.length === 0 ? (
              <View className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
                <Text className="text-sm text-amber-600">
                  No eligible habits. Create an active habit first — it can't already be in another
                  tower.
                </Text>
                <Button
                  onPress={() => router.push('/(tabs)/index/create' as never)}
                  className="mt-3"
                  variant="outline"
                >
                  <Text>Create Habit</Text>
                </Button>
              </View>
            ) : (
              <View className="gap-2">
                {eligibleHabits.map((detail) => (
                  <Pressable
                    key={detail.habit.id}
                    onPress={() => setSelectedHabitId(detail.habit.id)}
                    className={`flex-row items-center rounded-lg border p-3 ${
                      selectedHabitId === detail.habit.id
                        ? 'border-primary bg-primary/10'
                        : 'border-border bg-card'
                    }`}
                  >
                    <View className="flex-1">
                      <Text
                        className={`font-medium ${
                          selectedHabitId === detail.habit.id ? 'text-primary' : 'text-foreground'
                        }`}
                      >
                        {detail.habit.name}
                      </Text>
                      <Text className="text-xs text-muted-foreground">
                        {detail.habit.type} ·{' '}
                        {detail.habit.periodUnit === 'day' ? 'Daily' : 'Weekly'}
                      </Text>
                    </View>
                    {selectedHabitId === detail.habit.id && <Text className="text-primary">✓</Text>}
                  </Pressable>
                ))}
              </View>
            )}
          </View>

          {/* Period */}
          <View className="gap-2">
            <Label>Period</Label>
            <Controller
              control={control}
              name="periodUnit"
              render={({ field: { onChange, value } }) => (
                <View className="flex-row gap-2">
                  {(['day', 'week'] as const).map((unit) => (
                    <Pressable
                      key={unit}
                      onPress={() => onChange(unit)}
                      className={`flex-1 items-center rounded-lg border p-2 ${
                        value === unit ? 'border-primary bg-primary/10' : 'border-border bg-card'
                      }`}
                    >
                      <Text
                        className={`text-sm ${value === unit ? 'text-primary font-semibold' : 'text-foreground'}`}
                      >
                        {unit === 'day' ? 'Daily' : 'Weekly'}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              )}
            />
          </View>

          {/* Period length and quota */}
          <View className="flex-row gap-3">
            <View className="flex-1 gap-1">
              <Label>Period length</Label>
              <Controller
                control={control}
                name="periodLength"
                render={({ field: { onChange, onBlur, value } }) => (
                  <Input
                    value={value}
                    onChangeText={onChange}
                    onBlur={onBlur}
                    keyboardType="numeric"
                  />
                )}
              />
            </View>
            <View className="flex-1 gap-1">
              <Label>Quota</Label>
              <Controller
                control={control}
                name="quota"
                render={({ field: { onChange, onBlur, value } }) => (
                  <Input
                    value={value}
                    onChangeText={onChange}
                    onBlur={onBlur}
                    keyboardType="numeric"
                  />
                )}
              />
            </View>
          </View>

          {/* Week reset day (weekly only) */}
          {periodUnit === 'week' && (
            <View className="gap-2">
              <Label>Week starts on</Label>
              <Controller
                control={control}
                name="weekResetDay"
                render={({ field: { onChange, value } }) => (
                  <View className="flex-row gap-1.5">
                    {WEEKDAYS.map((day, i) => (
                      <Pressable
                        key={day}
                        onPress={() => onChange(String(i))}
                        className={`flex-1 items-center rounded-md py-2 ${
                          value === String(i) ? 'bg-primary' : 'bg-muted'
                        }`}
                      >
                        <Text
                          className={`text-xs ${
                            value === String(i)
                              ? 'font-semibold text-primary-foreground'
                              : 'text-foreground'
                          }`}
                        >
                          {day}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              />
            </View>
          )}

          {/* Deadline picker */}
          <Controller
            control={control}
            name="deadlineTime"
            render={({ field: { onChange, value } }) => (
              <DeadlinePicker value={value} onChange={onChange} />
            )}
          />

          {/* Timezone */}
          <View className="gap-1">
            <Label>Timezone</Label>
            <View className="rounded-lg border border-border bg-muted px-4 py-3">
              <Text className="text-sm text-foreground">{deviceTimezone}</Text>
            </View>
            <Text className="text-xs text-muted-foreground">Detected from your device</Text>
          </View>

          {/* Grace window */}
          <View className="gap-1">
            <Label>Grace window (minutes)</Label>
            <Controller
              control={control}
              name="graceWindowMinutes"
              render={({ field: { onChange, onBlur, value } }) => (
                <Input
                  value={value}
                  onChangeText={onChange}
                  onBlur={onBlur}
                  keyboardType="numeric"
                  placeholder="120"
                />
              )}
            />
            <Text className="text-xs text-muted-foreground">
              Extra time after deadline before the period is evaluated
            </Text>
          </View>

          {/* Advanced toggle */}
          <Pressable onPress={() => setShowAdvanced(!showAdvanced)}>
            <Text className="text-sm font-medium text-primary">
              {showAdvanced ? 'Hide advanced settings' : 'Show advanced settings'}
            </Text>
          </Pressable>

          {showAdvanced && (
            <View className="gap-4 rounded-lg border border-border bg-card p-4">
              <View className="gap-1">
                <Label>Wobble lead (minutes)</Label>
                <Text className="text-xs text-muted-foreground">
                  How long before deadline the tower starts wobbling. Default:{' '}
                  {DEFAULT_WOBBLE_LEAD_MINUTES} min.
                </Text>
              </View>
              <View className="gap-1">
                <Label>Nudge lead (minutes)</Label>
                <Text className="text-xs text-muted-foreground">
                  How long before deadline to send nudge notifications. Default:{' '}
                  {DEFAULT_NUDGE_LEAD_MINUTES} min. Must be greater than wobble lead.
                </Text>
              </View>
              <Text className="text-xs text-muted-foreground">
                These use the defaults ({DEFAULT_WOBBLE_LEAD_MINUTES} and{' '}
                {DEFAULT_NUDGE_LEAD_MINUTES} min). Customization coming soon.
              </Text>
            </View>
          )}

          {/* Submit */}
          <Button
            onPress={() => handleSubmit(onSubmit)()}
            disabled={createTower.isPending || !selectedHabitId}
            className="mt-2"
          >
            <Text>{createTower.isPending ? 'Creating...' : 'Create Tower'}</Text>
          </Button>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
