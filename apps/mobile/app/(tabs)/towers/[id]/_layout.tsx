import { Stack } from 'expo-router';
import { useColorScheme } from '~/lib/use-color-scheme';

export default function TowerDetailLayout() {
  const { isDark } = useColorScheme();

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: isDark ? 'hsl(240, 10%, 4%)' : 'hsl(0, 0%, 100%)' },
        headerTintColor: isDark ? 'hsl(0, 0%, 98%)' : 'hsl(240, 10%, 4%)',
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Tower' }} />
      <Stack.Screen name="history" options={{ title: 'Block History' }} />
    </Stack>
  );
}
