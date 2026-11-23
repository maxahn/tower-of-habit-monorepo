import { Link } from 'expo-router';
import { View } from 'react-native';
import { Button } from '~/components/ui/button';
import { Text } from '~/components/ui/text';

export default function HabitsScreen() {
  return (
    <View className="flex-1 items-center justify-center bg-background px-6">
      <Text variant="h3">Habits</Text>
      <Text variant="muted" className="mt-2 text-center">
        Create your first habit to get started.
      </Text>
      <Link href="/index/create" asChild>
        <Button className="mt-6">
          <Text>Create Habit</Text>
        </Button>
      </Link>
    </View>
  );
}
