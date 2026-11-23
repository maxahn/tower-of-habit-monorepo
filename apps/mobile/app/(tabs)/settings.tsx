import { useCallback, useEffect, useState } from 'react';
import { AppState, Linking, Platform, View } from 'react-native';
import Constants from 'expo-constants';
import { Button } from '~/components/ui/button';
import { Text } from '~/components/ui/text';
import { useAuth } from '~/lib/auth-context';
import {
  getPushPermissionStatus,
  registerForPushNotifications,
  type PushPermissionStatus,
} from '~/lib/push';

export default function SettingsScreen() {
  const { state, apiClient, signOut } = useAuth();
  const apiUrl = Constants.expoConfig?.extra?.apiUrl ?? 'not set';
  const user =
    state.status === 'authenticated' || state.status === 'onboarding' ? state.user : null;

  const [pushStatus, setPushStatus] = useState<PushPermissionStatus>('undetermined');

  const refreshPushStatus = useCallback(async () => {
    setPushStatus(await getPushPermissionStatus());
  }, []);

  useEffect(() => {
    refreshPushStatus();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') refreshPushStatus();
    });
    return () => sub.remove();
  }, [refreshPushStatus]);

  async function handleEnablePush() {
    if (pushStatus === 'denied') {
      if (Platform.OS === 'ios') {
        Linking.openURL('app-settings:');
      } else {
        Linking.openSettings();
      }
      return;
    }
    const result = await registerForPushNotifications(apiClient);
    setPushStatus(result === 'granted' ? 'granted' : 'denied');
  }

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

      <View className="mb-8 rounded-lg border border-border bg-card p-4">
        <Text className="text-base font-semibold text-foreground">Notifications</Text>
        <Text variant="muted" className="mt-1">
          {pushStatus === 'granted'
            ? 'Push notifications are enabled'
            : pushStatus === 'denied'
              ? 'Push notifications are disabled'
              : 'Push notifications have not been set up'}
        </Text>
        {pushStatus !== 'granted' && (
          <Button variant="outline" className="mt-3" onPress={handleEnablePush}>
            <Text>{pushStatus === 'denied' ? 'Open settings' : 'Turn on'}</Text>
          </Button>
        )}
      </View>

      <Button variant="destructive" onPress={signOut}>
        <Text>Sign out</Text>
      </Button>

      <Text className="mt-8 text-xs text-muted-foreground">API: {apiUrl}</Text>
    </View>
  );
}
