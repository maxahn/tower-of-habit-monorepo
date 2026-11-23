import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import * as SplashScreen from 'expo-splash-screen';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionUser, MeResponse } from '@tower-of-habit/shared';
import { createApiClient, type ApiClient } from './api-client';

const TOKEN_KEY = 'tower_session_token';

type User = SessionUser;

export type AuthState =
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'onboarding'; user: User }
  | { status: 'authenticated'; user: User };

type AuthContextValue = {
  state: AuthState;
  apiClient: ApiClient;
  signIn: (token: string, user: User, isNewUser: boolean) => void;
  signOut: () => void;
  updateUser: (user: User) => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  const tokenRef = useRef<string | null>(null);

  const baseUrl = Constants.expoConfig?.extra?.apiUrl ?? 'http://localhost:3000';

  const apiClient = useMemo(
    () =>
      createApiClient({
        baseUrl,
        getToken: () => tokenRef.current,
        setToken: (token) => {
          tokenRef.current = token;
          SecureStore.setItemAsync(TOKEN_KEY, token);
        },
        signOut: () => {
          tokenRef.current = null;
          SecureStore.deleteItemAsync(TOKEN_KEY);
          setState({ status: 'unauthenticated' });
        },
      }),
    [baseUrl]
  );

  useEffect(() => {
    (async () => {
      try {
        const token = await SecureStore.getItemAsync(TOKEN_KEY);
        if (!token) {
          setState({ status: 'unauthenticated' });
          return;
        }

        tokenRef.current = token;
        const { user } = await apiClient.apiFetch<MeResponse>('/v1/me');
        setState(
          user.displayName === null
            ? { status: 'onboarding', user }
            : { status: 'authenticated', user }
        );
      } catch {
        tokenRef.current = null;
        await SecureStore.deleteItemAsync(TOKEN_KEY);
        setState({ status: 'unauthenticated' });
      } finally {
        SplashScreen.hideAsync();
      }
    })();
  }, [apiClient]);

  function signIn(token: string, user: User, isNewUser: boolean) {
    tokenRef.current = token;
    SecureStore.setItemAsync(TOKEN_KEY, token);
    setState(
      isNewUser || user.displayName === null
        ? { status: 'onboarding', user }
        : { status: 'authenticated', user }
    );
  }

  function signOut() {
    const hadToken = tokenRef.current !== null;
    tokenRef.current = null;
    SecureStore.deleteItemAsync(TOKEN_KEY);
    setState({ status: 'unauthenticated' });
    if (hadToken) {
      apiClient.apiFetch('/v1/auth/logout', { method: 'POST', public: true }).catch(() => {});
    }
  }

  function updateUser(user: User) {
    setState((prev) => {
      if (prev.status === 'onboarding' && user.displayName !== null) {
        return { status: 'authenticated', user };
      }
      if (prev.status === 'authenticated' || prev.status === 'onboarding') {
        return { ...prev, user };
      }
      return prev;
    });
  }

  return (
    <AuthContext.Provider value={{ state, apiClient, signIn, signOut, updateUser }}>
      {children}
    </AuthContext.Provider>
  );
}
