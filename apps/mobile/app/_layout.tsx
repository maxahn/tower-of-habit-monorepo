import '../global.css';

import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { ErrorBoundary } from '~/components/error-boundary';
import { AuthProvider, useAuth } from '~/lib/auth-context';
import { setupOnlineManager } from '~/lib/online-manager';
import { createQueryClient } from '~/lib/query-client';

export default function RootLayout() {
  const [queryClient] = useState(createQueryClient);

  useEffect(() => {
    return setupOnlineManager();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ErrorBoundary>
          <QueryCacheCleaner />
          <RootNavigator />
        </ErrorBoundary>
      </AuthProvider>
    </QueryClientProvider>
  );
}

function QueryCacheCleaner() {
  const { state } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (state.status === 'unauthenticated') {
      queryClient.clear();
    }
  }, [state.status, queryClient]);

  return null;
}

function RootNavigator() {
  const { state } = useAuth();

  const isLoading = state.status === 'loading';
  const isAuthenticated = state.status === 'authenticated';
  const isOnboarding = state.status === 'onboarding';

  if (isLoading) return null;

  const authRedirect = isOnboarding ? '/(auth)/profile-setup' : '/(auth)/login';

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={isAuthenticated} redirectTo={authRedirect}>
        <Stack.Screen name="(tabs)" />
      </Stack.Protected>

      <Stack.Protected guard={!isAuthenticated} redirectTo="/index">
        <Stack.Screen name="(auth)" />
      </Stack.Protected>

      <Stack.Screen name="dev" />
    </Stack>
  );
}
