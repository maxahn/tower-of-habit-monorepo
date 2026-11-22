import { View, Text } from 'react-native';

export default function VerifyScreen() {
  return (
    <View className="flex-1 items-center justify-center bg-white dark:bg-neutral-950">
      <Text className="text-xl font-bold text-neutral-900 dark:text-neutral-100">Verify Code</Text>
      <Text className="mt-2 text-neutral-500">OTP verification — coming in 4.4</Text>
    </View>
  );
}
