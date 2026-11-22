import { View } from 'react-native';
import { Text } from '~/components/ui/text';

export default function VerifyScreen() {
  return (
    <View className="flex-1 items-center justify-center bg-background">
      <Text variant="h4">Verify Code</Text>
      <Text variant="muted" className="mt-2">
        OTP verification — coming in 4.4
      </Text>
    </View>
  );
}
