import { Stack } from 'expo-router';
import { useColorScheme } from '~/lib/use-color-scheme';

export default function HabitsLayout() {
  const { isDark } = useColorScheme();

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: isDark ? 'hsl(240, 10%, 4%)' : 'hsl(0, 0%, 100%)' },
        headerTintColor: isDark ? 'hsl(0, 0%, 98%)' : 'hsl(240, 10%, 4%)',
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="create" options={{ title: 'New Habit', presentation: 'modal' }} />
      <Stack.Screen name="[id]" options={{ title: 'Habit' }} />
      <Stack.Screen name="edit" options={{ title: 'Edit Habit', presentation: 'modal' }} />
    </Stack>
  );
}
