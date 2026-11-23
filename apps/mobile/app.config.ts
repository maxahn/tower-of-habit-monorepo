import { ExpoConfig, ConfigContext } from 'expo/config';

const IS_DEV = process.env.APP_VARIANT === 'dev';
const IS_STAGING = process.env.APP_VARIANT === 'staging';

const appName = IS_DEV ? '(Dev) TOH' : IS_STAGING ? '(Staging) TOH' : 'Tower of Habit';

const bundleId = IS_DEV
  ? 'com.mxahn.toh.dev'
  : IS_STAGING
    ? 'com.mxahn.toh.staging'
    : 'com.mxahn.toh';

const scheme = IS_DEV ? 'towerofhabit-dev' : IS_STAGING ? 'towerofhabit-staging' : 'towerofhabit';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: appName,
  slug: 'mobile',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  ios: {
    supportsTablet: true,
    bundleIdentifier: bundleId,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: bundleId,
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
  },
  web: {
    favicon: './assets/favicon.png',
    bundler: 'metro',
  },
  runtimeVersion: { policy: 'fingerprint' as const },
  updates: {
    url: 'https://u.expo.dev/1236b489-89d7-4c92-8bd3-4bbf4a48076b',
    checkAutomatically: 'ON_LOAD' as const,
    fallbackToCacheTimeout: 0,
  },
  extra: {
    apiUrl: process.env.API_URL ?? 'http://localhost:3000',
    eas: {
      projectId: '1236b489-89d7-4c92-8bd3-4bbf4a48076b',
    },
  },
  owner: 'mxahn',
  scheme,
  plugins: [
    'expo-router',
    'expo-splash-screen',
    [
      'expo-notifications',
      {
        icon: './assets/icon.png',
        color: '#E6F4FE',
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
});
