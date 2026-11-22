import { View } from 'react-native';
import { Text } from '~/components/ui/text';

export default function TowersScreen() {
  return (
    <View className="flex-1 items-center justify-center bg-background">
      <Text variant="h3">Towers</Text>
      <Text variant="muted" className="mt-2">
        Your towers will appear here
      </Text>
    </View>
  );
}
