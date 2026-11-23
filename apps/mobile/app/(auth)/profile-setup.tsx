import { useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import type { MeResponse } from '@tower-of-habit/shared';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Text } from '~/components/ui/text';
import { ApiError, NetworkError } from '~/lib/api-client';
import { useAuth } from '~/lib/auth-context';

export default function ProfileSetupScreen() {
  const { apiClient, updateUser, state } = useAuth();
  const deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const [displayName, setDisplayName] = useState('');
  const [timezone] = useState(state.status === 'onboarding' ? state.user.timezone : deviceTimezone);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const trimmed = displayName.trim();
  const valid = trimmed.length >= 2;

  async function handleSubmit() {
    if (!valid) return;
    setError('');
    setLoading(true);

    try {
      const { user } = await apiClient.apiFetch<MeResponse>('/v1/me', {
        method: 'PATCH',
        json: { displayName: trimmed, timezone },
      });
      updateUser(user);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else if (err instanceof NetworkError) {
        setError('No internet connection.');
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="flex-1 bg-background"
    >
      <View className="flex-1 justify-center px-6">
        <Text variant="h3" className="mb-2 text-center">
          Set up your profile
        </Text>
        <Text variant="muted" className="mb-8 text-center">
          Tell us a bit about yourself to get started
        </Text>

        <View className="gap-4">
          <View className="gap-2">
            <Label nativeID="display-name-label">Display name</Label>
            <Input
              aria-labelledby="display-name-label"
              placeholder="What should we call you?"
              value={displayName}
              onChangeText={setDisplayName}
              autoCapitalize="words"
              autoCorrect={false}
              editable={!loading}
              onSubmitEditing={handleSubmit}
              returnKeyType="done"
            />
            {trimmed.length > 0 && trimmed.length < 2 && (
              <Text className="text-xs text-destructive">At least 2 characters</Text>
            )}
          </View>

          <View className="gap-2">
            <Label nativeID="timezone-label">Timezone</Label>
            <Input aria-labelledby="timezone-label" value={timezone} editable={false} />
          </View>

          {error !== '' && <Text className="text-sm text-destructive">{error}</Text>}

          <Button onPress={handleSubmit} disabled={!valid || loading}>
            <Text>{loading ? 'Saving…' : 'Get started'}</Text>
          </Button>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
