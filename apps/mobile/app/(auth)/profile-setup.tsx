import { View } from 'react-native';
import { Text } from '~/components/ui/text';

export default function ProfileSetupScreen() {
  return (
    <View className="flex-1 items-center justify-center bg-background">
      <Text variant="h4">Profile Setup</Text>
      <Text variant="muted" className="mt-2">
        Display name + timezone — coming in 4.4
      </Text>
    </View>
  );
}
