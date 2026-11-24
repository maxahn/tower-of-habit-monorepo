import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  View,
} from 'react-native';
import Constants from 'expo-constants';
import type { MeResponse, MeSessionsResponse } from '@tower-of-habit/shared';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Separator } from '~/components/ui/separator';
import { Text } from '~/components/ui/text';
import { ApiError, NetworkError } from '~/lib/api-client';
import { useAuth } from '~/lib/auth-context';
import {
  getPushPermissionStatus,
  registerForPushNotifications,
  type PushPermissionStatus,
} from '~/lib/push';

export default function SettingsScreen() {
  const { state, apiClient, signOut, updateUser } = useAuth();
  const user =
    state.status === 'authenticated' || state.status === 'onboarding' ? state.user : null;

  // --- Profile editing ---
  const [editingProfile, setEditingProfile] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState('');

  function startEditProfile() {
    setDisplayName(user?.displayName ?? '');
    setProfileError('');
    setEditingProfile(true);
  }

  function cancelEditProfile() {
    setEditingProfile(false);
    setProfileError('');
  }

  async function saveProfile() {
    const trimmed = displayName.trim();
    if (trimmed.length < 2) {
      setProfileError('Display name must be at least 2 characters.');
      return;
    }
    setProfileSaving(true);
    setProfileError('');
    try {
      const { user: updated } = await apiClient.apiFetch<MeResponse>('/v1/me', {
        method: 'PATCH',
        json: { displayName: trimmed },
      });
      updateUser(updated);
      setEditingProfile(false);
    } catch (err) {
      if (err instanceof ApiError) setProfileError(err.message);
      else if (err instanceof NetworkError) setProfileError('No internet connection.');
      else setProfileError('Something went wrong.');
    } finally {
      setProfileSaving(false);
    }
  }

  // --- Push notifications ---
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
      if (Platform.OS === 'ios') Linking.openURL('app-settings:');
      else Linking.openSettings();
      return;
    }
    const result = await registerForPushNotifications(apiClient);
    setPushStatus(result === 'granted' ? 'granted' : 'denied');
  }

  // --- Sessions ---
  const [sessions, setSessions] = useState<MeSessionsResponse['sessions'] | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [revokingAll, setRevokingAll] = useState(false);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const { sessions: list } = await apiClient.apiFetch<MeSessionsResponse>('/v1/me/sessions');
      setSessions(list);
    } catch {
      setSessions(null);
    } finally {
      setSessionsLoading(false);
    }
  }, [apiClient]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  function handleRevokeAll() {
    const otherCount = sessions ? sessions.filter((s) => !s.current).length : 0;
    if (otherCount === 0) return;
    Alert.alert(
      'Sign out other devices?',
      `This will sign out ${otherCount} other session${otherCount > 1 ? 's' : ''}. You will stay signed in on this device.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign out others',
          style: 'destructive',
          onPress: async () => {
            setRevokingAll(true);
            try {
              await apiClient.apiFetch('/v1/auth/sessions/revoke-all', { method: 'POST' });
              await loadSessions();
            } catch {
              Alert.alert('Error', 'Could not sign out other sessions.');
            } finally {
              setRevokingAll(false);
            }
          },
        },
      ]
    );
  }

  // --- Sign out ---
  function handleSignOut() {
    Alert.alert('Sign out?', 'You will need to sign in again to use the app.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: signOut },
    ]);
  }

  const appVersion = Constants.expoConfig?.version ?? '1.0.0';
  const deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="flex-1 bg-background"
    >
      <ScrollView className="flex-1 px-6 pt-4" keyboardShouldPersistTaps="handled">
        <View className="gap-6 pb-12">
          {/* Profile */}
          <View className="rounded-lg border border-border bg-card p-4">
            <View className="flex-row items-center justify-between">
              <Text className="text-base font-semibold text-foreground">Profile</Text>
              {!editingProfile && (
                <Pressable onPress={startEditProfile}>
                  <Text className="text-sm text-primary">Edit</Text>
                </Pressable>
              )}
            </View>

            {editingProfile ? (
              <View className="mt-3 gap-3">
                <View className="gap-1">
                  <Label nativeID="edit-display-name">Display name</Label>
                  <Input
                    aria-labelledby="edit-display-name"
                    value={displayName}
                    onChangeText={setDisplayName}
                    autoCapitalize="words"
                    autoCorrect={false}
                    editable={!profileSaving}
                    returnKeyType="done"
                    onSubmitEditing={saveProfile}
                  />
                </View>
                <View className="gap-1">
                  <Label nativeID="edit-timezone">Timezone</Label>
                  <Input
                    aria-labelledby="edit-timezone"
                    value={user?.timezone ?? deviceTimezone}
                    editable={false}
                  />
                  <Text className="text-xs text-muted-foreground">
                    Detected from your device. Change your device timezone to update.
                  </Text>
                </View>
                {profileError !== '' && (
                  <Text className="text-sm text-destructive">{profileError}</Text>
                )}
                <View className="flex-row gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onPress={cancelEditProfile}
                    disabled={profileSaving}
                  >
                    <Text>Cancel</Text>
                  </Button>
                  <Button
                    size="sm"
                    className="flex-1"
                    onPress={saveProfile}
                    disabled={profileSaving}
                  >
                    <Text>{profileSaving ? 'Saving…' : 'Save'}</Text>
                  </Button>
                </View>
              </View>
            ) : (
              <View className="mt-2">
                <Text className="text-sm text-foreground">
                  {user?.displayName ?? 'No display name'}
                </Text>
                <Text variant="muted" className="mt-1">
                  {user?.email}
                </Text>
                <Text variant="muted" className="mt-1">
                  {user?.timezone}
                </Text>
              </View>
            )}
          </View>

          {/* Notifications */}
          <View className="rounded-lg border border-border bg-card p-4">
            <Text className="text-base font-semibold text-foreground">Notifications</Text>
            <Text variant="muted" className="mt-1">
              {pushStatus === 'granted'
                ? 'Push notifications are enabled'
                : pushStatus === 'denied'
                  ? 'Push notifications are blocked in system settings'
                  : 'Push notifications have not been set up'}
            </Text>
            {pushStatus !== 'granted' && (
              <Button
                variant="outline"
                size="sm"
                className="mt-3 self-start"
                onPress={handleEnablePush}
              >
                <Text>{pushStatus === 'denied' ? 'Open settings' : 'Turn on'}</Text>
              </Button>
            )}
          </View>

          {/* Sessions */}
          <View className="rounded-lg border border-border bg-card p-4">
            <Text className="text-base font-semibold text-foreground">Active sessions</Text>
            {sessionsLoading && !sessions ? (
              <ActivityIndicator className="mt-3" />
            ) : sessions ? (
              <View className="mt-2 gap-2">
                {sessions.map((session) => (
                  <View key={session.id} className="flex-row items-center justify-between py-1">
                    <View className="flex-1">
                      <Text className="text-sm text-foreground">
                        {session.current ? 'This device' : (session.userAgent ?? 'Unknown device')}
                      </Text>
                      <Text className="text-xs text-muted-foreground">
                        Last active{' '}
                        {new Date(session.lastSeenAt).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </Text>
                    </View>
                    {session.current && (
                      <View className="rounded bg-primary/10 px-2 py-0.5">
                        <Text className="text-xs font-medium text-primary">Current</Text>
                      </View>
                    )}
                  </View>
                ))}
                {sessions.filter((s) => !s.current).length > 0 && (
                  <>
                    <Separator className="my-1" />
                    <Button
                      variant="outline"
                      size="sm"
                      className="self-start"
                      onPress={handleRevokeAll}
                      disabled={revokingAll}
                    >
                      <Text>{revokingAll ? 'Signing out…' : 'Sign out other devices'}</Text>
                    </Button>
                  </>
                )}
              </View>
            ) : (
              <Text variant="muted" className="mt-2">
                Could not load sessions.
              </Text>
            )}
          </View>

          {/* Sign out */}
          <Button variant="destructive" onPress={handleSignOut}>
            <Text>Sign out</Text>
          </Button>

          {/* About */}
          <View className="items-center gap-1 pt-2">
            <Text className="text-xs text-muted-foreground">Tower of Habit v{appVersion}</Text>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
