import { View } from 'react-native';
import Constants from 'expo-constants';
import { Text } from '~/components/ui/text';

export default function SettingsScreen() {
  const apiUrl = Constants.expoConfig?.extra?.apiUrl ?? 'not set';

  return (
    <View className="flex-1 items-center justify-center bg-background">
      <Text variant="h3">Settings</Text>
      <Text variant="muted" className="mt-2">
        Account settings will appear here
      </Text>
      <Text className="mt-4 text-xs text-muted-foreground">API: {apiUrl}</Text>
    </View>
  );
}
