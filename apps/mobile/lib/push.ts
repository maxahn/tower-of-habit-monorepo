import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { ApiClient } from './api-client';

const PUSH_DECLINED_KEY = 'tower_push_declined';
const LAST_PUSH_TOKEN_KEY = 'tower_last_push_token';

export type PushPermissionStatus = 'granted' | 'denied' | 'undetermined';

export async function getPushPermissionStatus(): Promise<PushPermissionStatus> {
  if (!Device.isDevice) return 'undetermined';
  const { status } = await Notifications.getPermissionsAsync();
  if (status === 'granted') return 'granted';
  if (status === 'denied') return 'denied';
  return 'undetermined';
}

export async function hasDeclinedSoftPrompt(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(PUSH_DECLINED_KEY)) === 'true';
  } catch {
    return false;
  }
}

export async function setDeclinedSoftPrompt(): Promise<void> {
  try {
    await AsyncStorage.setItem(PUSH_DECLINED_KEY, 'true');
  } catch {
    // best-effort
  }
}

export async function registerForPushNotifications(
  apiClient: ApiClient
): Promise<'granted' | 'denied'> {
  if (!Device.isDevice) return 'denied';

  const { status: existing } = await Notifications.getPermissionsAsync();
  let finalStatus = existing;

  if (existing !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') return 'denied';

  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  const tokenData = await Notifications.getExpoPushTokenAsync({
    projectId,
  });
  const token = tokenData.data;
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';

  await apiClient.apiFetch('/v1/push-tokens', {
    method: 'POST',
    json: { token, platform },
  });

  try {
    await AsyncStorage.setItem(LAST_PUSH_TOKEN_KEY, token);
  } catch {
    // best-effort
  }

  return 'granted';
}

export async function refreshPushTokenIfNeeded(apiClient: ApiClient): Promise<void> {
  if (!Device.isDevice) return;

  const { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') return;

  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  const tokenData = await Notifications.getExpoPushTokenAsync({
    projectId,
  });
  const token = tokenData.data;

  let lastToken: string | null = null;
  try {
    lastToken = await AsyncStorage.getItem(LAST_PUSH_TOKEN_KEY);
  } catch {
    // best-effort
  }

  if (token === lastToken) return;

  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  await apiClient.apiFetch('/v1/push-tokens', {
    method: 'POST',
    json: { token, platform },
  });

  try {
    await AsyncStorage.setItem(LAST_PUSH_TOKEN_KEY, token);
  } catch {
    // best-effort
  }
}
