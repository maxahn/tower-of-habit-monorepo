import '../global.css';

import { QueryClientProvider } from '@tanstack/react-query';
import { Redirect, Slot } from 'expo-router';
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
          <AuthGate />
        </ErrorBoundary>
      </AuthProvider>
    </QueryClientProvider>
  );
}

function AuthGate() {
  const { state } = useAuth();

  if (state.status === 'loading') return null;
  if (state.status === 'unauthenticated') return <Redirect href="/(auth)/login" />;
  if (state.status === 'onboarding') return <Redirect href="/(auth)/profile-setup" />;
  return <Slot />;
}
