import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Text } from '~/components/ui/text';
import { ApiError, NetworkError } from '~/lib/api-client';
import { useAuth } from '~/lib/auth-context';

const COOLDOWN_SECONDS = 30;

export default function LoginScreen() {
  const { apiClient } = useAuth();
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const startCooldown = useCallback(() => {
    setCooldown(COOLDOWN_SECONDS);
    timerRef.current = setInterval(() => {
      setCooldown((prev) => {
        if (prev <= 1) {
          clearInterval(timerRef.current!);
          timerRef.current = null;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  async function handleSubmit() {
    const trimmed = email.trim();
    if (!trimmed) return;
    setError('');
    setLoading(true);

    try {
      await apiClient.apiFetch('/v1/auth/request-code', {
        json: { email: trimmed },
        public: true,
      });
      startCooldown();
      router.push({ pathname: '/(auth)/verify', params: { email: trimmed } });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429) setError('Too many attempts. Try again later.');
        else if (err.status === 422) setError("This email can't receive codes.");
        else setError(err.message);
      } else if (err instanceof NetworkError) {
        setError('No internet connection. Please check your network.');
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }

  const disabled = loading || cooldown > 0 || !email.trim();

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="flex-1 bg-background"
    >
      <View className="flex-1 justify-center px-6">
        <Text variant="h3" className="mb-2 text-center">
          Tower of Habit
        </Text>
        <Text variant="muted" className="mb-8 text-center">
          Sign in with your email to get started
        </Text>

        <View className="gap-4">
          <View className="gap-2">
            <Label nativeID="email-label">Email</Label>
            <Input
              aria-labelledby="email-label"
              placeholder="you@example.com"
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              editable={!loading}
              onSubmitEditing={handleSubmit}
              returnKeyType="go"
            />
          </View>

          {error !== '' && <Text className="text-sm text-destructive">{error}</Text>}

          <Button onPress={handleSubmit} disabled={disabled}>
            <Text>
              {cooldown > 0
                ? `Resend in ${cooldown}s`
                : loading
                  ? 'Sending…'
                  : 'Continue with email'}
            </Text>
          </Button>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
