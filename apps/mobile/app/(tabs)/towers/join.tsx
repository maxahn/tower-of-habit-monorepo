import { router } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  View,
} from 'react-native';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Text } from '~/components/ui/text';
import { useEligibleHabits, useJoinTower } from '~/lib/hooks/use-towers';

function stripNonAlphanumeric(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function formatCode(raw: string): string {
  const clean = stripNonAlphanumeric(raw).slice(0, 8);
  if (clean.length > 4) return `${clean.slice(0, 4)}-${clean.slice(4)}`;
  return clean;
}

export default function JoinTowerScreen() {
  const [rawCode, setRawCode] = useState('');
  const [selectedHabitId, setSelectedHabitId] = useState<string | null>(null);
  const joinTower = useJoinTower();
  const { data: eligibleHabits, isLoading: habitsLoading } = useEligibleHabits();

  const cleanCode = stripNonAlphanumeric(rawCode);
  const codeValid = cleanCode.length === 8;

  function handleCodeChange(text: string) {
    setRawCode(formatCode(text));
  }

  function handleSubmit() {
    if (!codeValid) {
      Alert.alert('Invalid Code', 'Enter an 8-character join code.');
      return;
    }
    if (!selectedHabitId) {
      Alert.alert('Select a Habit', 'Pick a habit to bring into this tower.');
      return;
    }
    joinTower.mutate(
      { joinCode: cleanCode, habitId: selectedHabitId },
      {
        onSuccess: (data) => {
          if (data && 'tower' in data) {
            router.replace(`./${data.tower.id}` as never);
          } else {
            router.back();
          }
        },
        onError: (err) => {
          const message = err.message;
          if (message.includes('404') || message.toLowerCase().includes('not found')) {
            Alert.alert('Invalid Code', 'No tower found with that code. Check and try again.');
          } else if (message.includes('409') || message.toLowerCase().includes('already')) {
            Alert.alert('Already Joined', "You're already a member of this tower.");
          } else if (message.includes('429') || message.toLowerCase().includes('rate')) {
            Alert.alert('Too Many Attempts', 'Please wait a moment before trying again.');
          } else {
            Alert.alert('Error', message);
          }
        },
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
          {/* Join code input */}
          <View className="gap-1">
            <Label>Join Code</Label>
            <Input
              placeholder="XXXX-XXXX"
              value={rawCode}
              onChangeText={handleCodeChange}
              autoCapitalize="characters"
              autoCorrect={false}
              autoFocus
              maxLength={9}
              className="text-center text-2xl font-bold tracking-widest"
            />
            <Text className="text-xs text-muted-foreground">
              Enter the 8-character code shared by the tower host.
            </Text>
          </View>

          {/* Habit picker */}
          <View className="gap-2">
            <Label>Habit to bring</Label>
            {habitsLoading ? (
              <ActivityIndicator />
            ) : !eligibleHabits || eligibleHabits.length === 0 ? (
              <View className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
                <Text className="text-sm text-amber-600">
                  No eligible habits. Create an active habit first — it can't already be in another
                  tower.
                </Text>
                <Button
                  onPress={() => router.push('/(tabs)/habits/create' as never)}
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

          {/* Submit */}
          <Button
            onPress={handleSubmit}
            disabled={joinTower.isPending || !codeValid || !selectedHabitId}
            className="mt-2"
          >
            <Text>{joinTower.isPending ? 'Joining...' : 'Join Tower'}</Text>
          </Button>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
