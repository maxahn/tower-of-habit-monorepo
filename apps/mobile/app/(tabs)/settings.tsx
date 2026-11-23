import { View } from 'react-native';
import Constants from 'expo-constants';
import { Button } from '~/components/ui/button';
import { Text } from '~/components/ui/text';
import { useAuth } from '~/lib/auth-context';

export default function SettingsScreen() {
  const { state, signOut } = useAuth();
  const apiUrl = Constants.expoConfig?.extra?.apiUrl ?? 'not set';
  const user =
    state.status === 'authenticated' || state.status === 'onboarding' ? state.user : null;

  return (
    <View className="flex-1 bg-background px-6 pt-12">
      <Text variant="h3" className="mb-6">
        Settings
      </Text>

      {user && (
        <View className="mb-8 rounded-lg border border-border bg-card p-4">
          <Text className="text-base font-semibold text-foreground">
            {user.displayName ?? user.email}
          </Text>
          <Text variant="muted" className="mt-1">
            {user.email}
          </Text>
          <Text variant="muted" className="mt-1">
            {user.timezone}
          </Text>
        </View>
      )}

      <Button variant="destructive" onPress={signOut}>
        <Text>Sign out</Text>
      </Button>

      <Text className="mt-8 text-xs text-muted-foreground">API: {apiUrl}</Text>
    </View>
  );
}
