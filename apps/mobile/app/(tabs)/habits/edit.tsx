import { zodResolver } from '@hookform/resolvers/zod';
import { router, useLocalSearchParams } from 'expo-router';
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
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Text } from '~/components/ui/text';
import { useHabit, useUpdateHabit } from '~/lib/hooks/use-habits';

const editSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  periodUnit: z.enum(['day', 'week']),
  periodLength: z.string(),
  quota: z.string(),
  unit: z.string().max(100).optional(),
});

type FormValues = z.infer<typeof editSchema>;

export default function EditHabitScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, isLoading } = useHabit(id!);
  const updateHabit = useUpdateHabit(id!);

  const habit = data?.habit;

  const {
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(editSchema),
    values: habit
      ? {
          name: habit.name,
          periodUnit: habit.periodUnit,
          periodLength: String(habit.periodLength),
          quota: String(habit.quota),
          unit: habit.unit ?? '',
        }
      : undefined,
  });

  if (isLoading || !habit) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    );
  }

  function onSubmit(values: FormValues) {
    const periodLength = parseInt(values.periodLength, 10);
    const quota = parseInt(values.quota, 10);
    if (isNaN(periodLength) || periodLength < 1) {
      Alert.alert('Validation Error', 'Period length must be at least 1');
      return;
    }
    if (isNaN(quota) || quota < 1) {
      Alert.alert('Validation Error', 'Quota must be at least 1');
      return;
    }

    updateHabit.mutate(
      {
        name: values.name,
        periodUnit: values.periodUnit,
        periodLength,
        quota,
        unit: habit!.type === 'numeric' ? values.unit?.trim() || null : null,
      },
      {
        onSuccess: () => router.back(),
        onError: (err) => Alert.alert('Error', err.message),
      }
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="flex-1 bg-background"
    >
      <ScrollView className="flex-1 px-6 pt-6" keyboardShouldPersistTaps="handled">
        <View className="gap-5 pb-12">
          {/* Type (read-only) */}
          <View className="gap-1">
            <Label>Type</Label>
            <View className="rounded-lg border border-border bg-muted px-3 py-2">
              <Text className="text-sm text-muted-foreground capitalize">{habit.type}</Text>
            </View>
          </View>

          {/* Name */}
          <View className="gap-1">
            <Label>Name</Label>
            <Controller
              control={control}
              name="name"
              render={({ field: { onChange, onBlur, value } }) => (
                <Input value={value} onChangeText={onChange} onBlur={onBlur} />
              )}
            />
            {errors.name && <Text className="text-sm text-destructive">{errors.name.message}</Text>}
          </View>

          {/* Unit (numeric only) */}
          {habit.type === 'numeric' && (
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
          <View className="gap-1">
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

          {/* Submit */}
          <Button
            onPress={() => handleSubmit(onSubmit)()}
            disabled={updateHabit.isPending}
            className="mt-2"
          >
            <Text>{updateHabit.isPending ? 'Saving...' : 'Save Changes'}</Text>
          </Button>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
