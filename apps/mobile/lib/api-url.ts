import Constants from 'expo-constants';

const DEFAULT_API_URL = 'http://localhost:3000';

export function getApiBaseUrl(): string {
  const configured = Constants.expoConfig?.extra?.apiUrl as string | undefined;

  if (configured && !/^https?:\/\/localhost[:/]/.test(configured)) {
    return configured;
  }

  if (__DEV__) {
    const debuggerHost = Constants.debuggerHost ?? Constants.expoConfig?.hostUri;
    if (debuggerHost) {
      const lanIp = debuggerHost.split(':')[0];
      return `http://${lanIp}:3000`;
    }
  }

  return configured ?? DEFAULT_API_URL;
}
