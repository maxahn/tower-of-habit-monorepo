import { View, Text } from 'react-native';
import Constants from 'expo-constants';

export default function SettingsScreen() {
  const apiUrl = Constants.expoConfig?.extra?.apiUrl ?? 'not set';

  return (
    <View className="flex-1 items-center justify-center bg-white dark:bg-neutral-950">
      <Text className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">Settings</Text>
      <Text className="mt-2 text-neutral-500">Account settings will appear here</Text>
      <Text className="mt-4 text-xs text-neutral-400">API: {apiUrl}</Text>
    </View>
  );
}
