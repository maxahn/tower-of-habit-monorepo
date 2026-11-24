import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  View,
  TextInput,
} from 'react-native';
import type { TextInputInstance } from 'react-native';
import type { VerifyCodeResponse } from '@tower-of-habit/shared';
import { Button } from '~/components/ui/button';
import { Text } from '~/components/ui/text';
import { ApiError, NetworkError } from '~/lib/api-client';
import { useAuth } from '~/lib/auth-context';

const CODE_LENGTH = 6;
const COOLDOWN_SECONDS = 30;

export default function VerifyScreen() {
  const { email } = useLocalSearchParams<{ email: string }>();
  const { apiClient, signIn } = useAuth();

  const [digits, setDigits] = useState<string[]>(Array(CODE_LENGTH).fill(''));
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(COOLDOWN_SECONDS);
  const [failCount, setFailCount] = useState(0);

  const inputRefs = useRef<(TextInputInstance | null)[]>([]);
  const shakeAnim = useRef(new Animated.Value(0)).current;
  const cooldownTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    cooldownTimer.current = setInterval(() => {
      setResendCooldown((prev) => {
        if (prev <= 1) {
          clearInterval(cooldownTimer.current!);
          cooldownTimer.current = null;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => {
      if (cooldownTimer.current) clearInterval(cooldownTimer.current);
    };
  }, []);

  const shake = useCallback(() => {
    shakeAnim.setValue(0);
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  }, [shakeAnim]);

  async function submitCode(code: string) {
    setError('');
    setLoading(true);
    Keyboard.dismiss();

    try {
      const result = await apiClient.apiFetch<VerifyCodeResponse>('/v1/auth/verify-code', {
        json: {
          email,
          code,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        public: true,
      });
      signIn(result.token, result.expiresAt, result.user, result.isNewUser);
      if (result.isNewUser || result.user.displayName === null) {
        router.replace('/(auth)/profile-setup');
      } else {
        router.replace('/(tabs)/index');
      }
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          const next = failCount + 1;
          setFailCount(next);
          if (next >= 5) {
            setError('Too many failed attempts.');
            setTimeout(() => router.replace('/(auth)/login'), 1500);
            return;
          }
          setError('Invalid code. Please try again.');
          shake();
          setDigits(Array(CODE_LENGTH).fill(''));
          setTimeout(() => inputRefs.current[0]?.focus(), 100);
        } else if (err.status === 429) {
          setError('Too many attempts. Please try again later.');
          setTimeout(() => router.replace('/(auth)/login'), 1500);
        } else {
          setError(err.message);
        }
      } else if (err instanceof NetworkError) {
        setError('No internet connection.');
      } else {
        setError('Something went wrong.');
      }
    } finally {
      setLoading(false);
    }
  }

  function handleChange(index: number, value: string) {
    // Handle paste: if the value is a full code, fill all boxes.
    if (value.length >= CODE_LENGTH) {
      const pasted = value.replace(/\D/g, '').slice(0, CODE_LENGTH);
      if (pasted.length === CODE_LENGTH) {
        const newDigits = pasted.split('');
        setDigits(newDigits);
        inputRefs.current[CODE_LENGTH - 1]?.focus();
        submitCode(pasted);
        return;
      }
    }

    const digit = value.replace(/\D/g, '').slice(-1);
    const newDigits = [...digits];
    newDigits[index] = digit;
    setDigits(newDigits);

    if (digit && index < CODE_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }

    // Auto-submit when all digits filled.
    if (digit && index === CODE_LENGTH - 1) {
      const code = newDigits.join('');
      if (code.length === CODE_LENGTH) {
        submitCode(code);
      }
    }
  }

  function handleKeyPress(index: number, key: string) {
    if (key === 'Backspace' && !digits[index] && index > 0) {
      const newDigits = [...digits];
      newDigits[index - 1] = '';
      setDigits(newDigits);
      inputRefs.current[index - 1]?.focus();
    }
  }

  async function handleResend() {
    setError('');
    try {
      await apiClient.apiFetch('/v1/auth/request-code', {
        json: { email },
        public: true,
      });
      setResendCooldown(COOLDOWN_SECONDS);
      cooldownTimer.current = setInterval(() => {
        setResendCooldown((prev) => {
          if (prev <= 1) {
            clearInterval(cooldownTimer.current!);
            cooldownTimer.current = null;
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } catch {
      setError('Could not resend code.');
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="flex-1 bg-background"
    >
      <View className="flex-1 justify-center px-6">
        <Pressable onPress={() => router.back()} className="mb-8">
          <Text className="text-primary">← Back</Text>
        </Pressable>

        <Text variant="h3" className="mb-2 text-center">
          Check your email
        </Text>
        <Text variant="muted" className="mb-8 text-center">
          Enter the 6-digit code sent to {email}
        </Text>

        <Animated.View
          style={{ transform: [{ translateX: shakeAnim }] }}
          className="mb-4 flex-row justify-center gap-2"
        >
          {digits.map((digit, i) => (
            <TextInput
              key={i}
              ref={(ref) => {
                inputRefs.current[i] = ref;
              }}
              className="h-14 w-11 rounded-lg border border-border bg-background text-center text-2xl font-bold text-foreground"
              value={digit}
              onChangeText={(v) => handleChange(i, v)}
              onKeyPress={({ nativeEvent }) => handleKeyPress(i, nativeEvent.key)}
              keyboardType="number-pad"
              maxLength={i === 0 ? CODE_LENGTH : 1}
              textContentType="oneTimeCode"
              autoComplete={i === 0 ? 'one-time-code' : 'off'}
              autoFocus={i === 0}
              editable={!loading}
              selectTextOnFocus
            />
          ))}
        </Animated.View>

        {error !== '' && <Text className="mb-4 text-center text-sm text-destructive">{error}</Text>}

        <Button
          onPress={() => submitCode(digits.join(''))}
          disabled={loading || digits.join('').length < CODE_LENGTH}
          className="mb-4"
        >
          <Text>{loading ? 'Verifying…' : 'Verify'}</Text>
        </Button>

        <Pressable onPress={handleResend} disabled={resendCooldown > 0}>
          <Text variant="muted" className="text-center">
            {resendCooldown > 0 ? `Resend code in ${resendCooldown}s` : 'Resend code'}
          </Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
