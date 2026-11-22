import { View, Text } from 'react-native';
import { TEST_IMPORT } from '@tower-of-habit/shared';

export default function HabitsScreen() {
  return (
    <View className="flex-1 items-center justify-center bg-white dark:bg-neutral-950">
      <Text className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">Habits</Text>
      <Text className="mt-2 text-neutral-500">Your habits will appear here</Text>
      <Text className="mt-4 text-xs text-neutral-400">shared import: {TEST_IMPORT}</Text>
    </View>
  );
}
