import { View } from 'react-native';
import { Text } from '~/components/ui/text';
import { TEST_IMPORT } from '@tower-of-habit/shared';

export default function HabitsScreen() {
  return (
    <View className="flex-1 items-center justify-center bg-background">
      <Text variant="h3">Habits</Text>
      <Text variant="muted" className="mt-2">
        Your habits will appear here
      </Text>
      <Text className="mt-4 text-xs text-muted-foreground">shared import: {TEST_IMPORT}</Text>
    </View>
  );
}
