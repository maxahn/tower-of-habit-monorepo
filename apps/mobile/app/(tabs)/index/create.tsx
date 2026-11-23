import { zodResolver } from '@hookform/resolvers/zod';
import { router } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { z } from 'zod';
import { TierLadderEditor, type TierRow } from '~/components/tier-ladder-editor';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Text } from '~/components/ui/text';
import { useCreateHabit } from '~/lib/hooks/use-habits';
import type { CreateHabitRequest, HabitType } from '@tower-of-habit/shared';

const baseSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  periodUnit: z.enum(['day', 'week']),
  periodLength: z.string(),
  quota: z.string(),
  unit: z.string().max(100).optional(),
});

type FormValues = z.infer<typeof baseSchema>;

const TYPE_OPTIONS: { value: HabitType; label: string; description: string }[] = [
  { value: 'binary', label: 'Binary', description: 'Did you do it?' },
  { value: 'numeric', label: 'Numeric', description: 'How much?' },
  { value: 'tiered', label: 'Tiered', description: 'Which level?' },
];

function buildRequest(
  type: HabitType,
  values: FormValues,
  tiers: TierRow[]
): CreateHabitRequest | { error: string } {
  const periodLength = parseInt(values.periodLength, 10);
  const quota = parseInt(values.quota, 10);
  if (isNaN(periodLength) || periodLength < 1) return { error: 'Period length must be at least 1' };
  if (isNaN(quota) || quota < 1) return { error: 'Quota must be at least 1' };

  const base = {
    name: values.name,
    periodUnit: values.periodUnit,
    periodLength,
    quota,
  };

  if (type === 'binary') {
    return { ...base, type: 'binary' as const };
  }

  const parsedTiers = tiers.map((t, i) => ({
    tierIndex: i,
    label: t.label.trim(),
    thresholdValue: type === 'numeric' || t.thresholdValue ? Number(t.thresholdValue) : null,
  }));

  for (const t of parsedTiers) {
    if (!t.label) return { error: 'All tiers need a label' };
    if (type === 'numeric' && (t.thresholdValue === null || isNaN(t.thresholdValue))) {
      return { error: 'Numeric tiers need a threshold value' };
    }
  }

  if (type === 'numeric') {
    for (let i = 1; i < parsedTiers.length; i++) {
      if (parsedTiers[i]!.thresholdValue! <= parsedTiers[i - 1]!.thresholdValue!) {
        return { error: 'Thresholds must be strictly increasing' };
      }
    }
    if (!values.unit?.trim()) return { error: 'Numeric habits need a unit' };
    return { ...base, type: 'numeric' as const, unit: values.unit!.trim(), tiers: parsedTiers };
  }

  return { ...base, type: 'tiered' as const, tiers: parsedTiers };
}

export default function CreateHabitScreen() {
  const [habitType, setHabitType] = useState<HabitType>('binary');
  const [tiers, setTiers] = useState<TierRow[]>([{ label: '', thresholdValue: '' }]);
  const createHabit = useCreateHabit();

  const {
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(baseSchema),
    defaultValues: {
      name: '',
      periodUnit: 'day',
      periodLength: '1',
      quota: '1',
      unit: '',
    },
  });

  function onSubmit(values: FormValues) {
    const result = buildRequest(habitType, values, tiers);
    if ('error' in result) {
      Alert.alert('Validation Error', result.error);
      return;
    }
    createHabit.mutate(result, {
      onSuccess: () => router.back(),
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
          {/* Habit type selector */}
          <View className="gap-2">
            <Label>Type</Label>
            <View className="flex-row gap-2">
              {TYPE_OPTIONS.map((opt) => (
                <Pressable
                  key={opt.value}
                  onPress={() => {
                    setHabitType(opt.value);
                    if (opt.value === 'binary') setTiers([{ label: '', thresholdValue: '' }]);
                  }}
                  className={`flex-1 items-center rounded-lg border p-3 ${
                    habitType === opt.value
                      ? 'border-primary bg-primary/10'
                      : 'border-border bg-card'
                  }`}
                >
                  <Text
                    className={`text-sm font-semibold ${
                      habitType === opt.value ? 'text-primary' : 'text-foreground'
                    }`}
                  >
                    {opt.label}
                  </Text>
                  <Text className="mt-0.5 text-xs text-muted-foreground">{opt.description}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          {/* Name */}
          <View className="gap-1">
            <Label>Name</Label>
            <Controller
              control={control}
              name="name"
              render={({ field: { onChange, onBlur, value } }) => (
                <Input
                  placeholder="e.g. Morning run"
                  value={value}
                  onChangeText={onChange}
                  onBlur={onBlur}
                  autoFocus
                />
              )}
            />
            {errors.name && <Text className="text-sm text-destructive">{errors.name.message}</Text>}
          </View>

          {/* Unit (numeric only) */}
          {habitType === 'numeric' && (
            <View className="gap-1">
              <Label>Unit</Label>
              <Controller
                control={control}
                name="unit"
                render={({ field: { onChange, onBlur, value } }) => (
                  <Input
                    placeholder="e.g. minutes, pages, km"
                    value={value}
                    onChangeText={onChange}
                    onBlur={onBlur}
                  />
                )}
              />
            </View>
          )}

          {/* Period */}
          <View className="flex-row gap-3">
            <View className="flex-1 gap-1">
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
              {errors.periodLength && (
                <Text className="text-sm text-destructive">{errors.periodLength.message}</Text>
              )}
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
              {errors.quota && (
                <Text className="text-sm text-destructive">{errors.quota.message}</Text>
              )}
            </View>
          </View>

          {/* Tier ladder (numeric / tiered) */}
          {habitType !== 'binary' && (
            <TierLadderEditor
              tiers={tiers}
              onChange={setTiers}
              showThreshold
              thresholdLabel={habitType === 'numeric' ? 'Min value' : 'Threshold (optional)'}
            />
          )}

          {/* Submit */}
          <Button
            onPress={handleSubmit(onSubmit)}
            disabled={createHabit.isPending}
            className="mt-2"
          >
            <Text>{createHabit.isPending ? 'Creating...' : 'Create Habit'}</Text>
          </Button>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
