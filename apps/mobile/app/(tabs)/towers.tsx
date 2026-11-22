import { View, Text } from 'react-native';

export default function TowersScreen() {
  return (
    <View className="flex-1 items-center justify-center bg-white dark:bg-neutral-950">
      <Text className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">Towers</Text>
      <Text className="mt-2 text-neutral-500">Your towers will appear here</Text>
    </View>
  );
}
