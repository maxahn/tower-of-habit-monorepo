import { Tabs } from 'expo-router';
import { useColorScheme } from '~/lib/use-color-scheme';

export default function TabLayout() {
  const { isDark } = useColorScheme();

  return (
    <Tabs
      screenOptions={{
        headerShown: true,
        tabBarActiveTintColor: isDark ? 'hsl(217, 91%, 60%)' : 'hsl(221, 83%, 53%)',
        tabBarStyle: { backgroundColor: isDark ? 'hsl(240, 10%, 4%)' : 'hsl(0, 0%, 100%)' },
        headerStyle: { backgroundColor: isDark ? 'hsl(240, 10%, 4%)' : 'hsl(0, 0%, 100%)' },
        headerTintColor: isDark ? 'hsl(0, 0%, 98%)' : 'hsl(240, 10%, 4%)',
        tabBarInactiveTintColor: isDark ? 'hsl(240, 5%, 65%)' : 'hsl(240, 4%, 46%)',
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Habits',
          tabBarLabel: 'Habits',
          headerShown: false,
        }}
      />
      <Tabs.Screen
        name="towers"
        options={{
          title: 'Towers',
          tabBarLabel: 'Towers',
          headerShown: false,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarLabel: 'Settings',
        }}
      />
    </Tabs>
  );
}
