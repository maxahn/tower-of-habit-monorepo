import { Tabs } from 'expo-router';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: true,
        tabBarActiveTintColor: '#2563eb',
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Habits',
          tabBarLabel: 'Habits',
        }}
      />
      <Tabs.Screen
        name="towers"
        options={{
          title: 'Towers',
          tabBarLabel: 'Towers',
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
