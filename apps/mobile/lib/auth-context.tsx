import * as SecureStore from 'expo-secure-store';
import * as SplashScreen from 'expo-splash-screen';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { SessionUser, MeResponse } from '@tower-of-habit/shared';
import { createApiClient, type ApiClient } from './api-client';
import { getApiBaseUrl } from './api-url';
import { refreshPushTokenIfNeeded } from './push';

const TOKEN_KEY = 'tower_session_token';
const EXPIRES_AT_KEY = 'tower_session_expires_at';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

type User = SessionUser;

export type AuthState =
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'onboarding'; user: User }
  | { status: 'authenticated'; user: User };

type AuthContextValue = {
  state: AuthState;
  apiClient: ApiClient;
  signIn: (token: string, expiresAt: string, user: User, isNewUser: boolean) => void;
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
  const expiresAtRef = useRef<string | null>(null);

  const baseUrl = getApiBaseUrl();

  const apiClient = useMemo(
    () =>
      createApiClient({
        baseUrl,
        getToken: () => tokenRef.current,
        setToken: (token, expiresAt) => {
          tokenRef.current = token;
          SecureStore.setItemAsync(TOKEN_KEY, token);
          if (expiresAt) {
            expiresAtRef.current = expiresAt;
            SecureStore.setItemAsync(EXPIRES_AT_KEY, expiresAt);
          }
        },
        signOut: () => {
          tokenRef.current = null;
          expiresAtRef.current = null;
          SecureStore.deleteItemAsync(TOKEN_KEY);
          SecureStore.deleteItemAsync(EXPIRES_AT_KEY);
          setState({ status: 'unauthenticated' });
        },
      }),
    [baseUrl]
  );

  useEffect(() => {
    (async () => {
      try {
        const token = await SecureStore.getItemAsync(TOKEN_KEY);
        const expiresAt = await SecureStore.getItemAsync(EXPIRES_AT_KEY);
        if (!token) {
          setState({ status: 'unauthenticated' });
          return;
        }

        tokenRef.current = token;
        expiresAtRef.current = expiresAt;

        if (expiresAt && new Date(expiresAt).getTime() < Date.now()) {
          tokenRef.current = null;
          expiresAtRef.current = null;
          await SecureStore.deleteItemAsync(TOKEN_KEY);
          await SecureStore.deleteItemAsync(EXPIRES_AT_KEY);
          setState({ status: 'unauthenticated' });
          return;
        }

        if (expiresAt && new Date(expiresAt).getTime() - Date.now() < SEVEN_DAYS_MS) {
          await apiClient.refreshToken();
        }

        const { user } = await apiClient.apiFetch<MeResponse>('/v1/me');
        setState(
          user.displayName === null
            ? { status: 'onboarding', user }
            : { status: 'authenticated', user }
        );
      } catch {
        tokenRef.current = null;
        expiresAtRef.current = null;
        await SecureStore.deleteItemAsync(TOKEN_KEY);
        await SecureStore.deleteItemAsync(EXPIRES_AT_KEY);
        setState({ status: 'unauthenticated' });
      } finally {
        SplashScreen.hideAsync();
      }
    })();
  }, [apiClient]);

  // Proactive refresh on foreground
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') return;
      const expiresAt = expiresAtRef.current;
      if (!expiresAt || !tokenRef.current) return;
      if (new Date(expiresAt).getTime() - Date.now() < SEVEN_DAYS_MS) {
        apiClient.refreshToken().catch(() => {});
      }
      refreshPushTokenIfNeeded(apiClient).catch(() => {});
    });
    return () => subscription.remove();
  }, [apiClient]);

  function signIn(token: string, expiresAt: string, user: User, isNewUser: boolean) {
    tokenRef.current = token;
    expiresAtRef.current = expiresAt;
    SecureStore.setItemAsync(TOKEN_KEY, token);
    SecureStore.setItemAsync(EXPIRES_AT_KEY, expiresAt);
    setState(
      isNewUser || user.displayName === null
        ? { status: 'onboarding', user }
        : { status: 'authenticated', user }
    );
  }

  function signOut() {
    const hadToken = tokenRef.current !== null;
    tokenRef.current = null;
    expiresAtRef.current = null;
    SecureStore.deleteItemAsync(TOKEN_KEY);
    SecureStore.deleteItemAsync(EXPIRES_AT_KEY);
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
