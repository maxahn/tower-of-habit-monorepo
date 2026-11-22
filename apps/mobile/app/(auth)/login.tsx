import { View } from 'react-native';
import { Text } from '~/components/ui/text';

export default function LoginScreen() {
  return (
    <View className="flex-1 items-center justify-center bg-background">
      <Text variant="h4">Login</Text>
      <Text variant="muted" className="mt-2">
        Email OTP login — coming in 4.4
      </Text>
    </View>
  );
}
