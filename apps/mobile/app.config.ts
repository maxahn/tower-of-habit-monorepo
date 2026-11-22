import { ExpoConfig, ConfigContext } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Tower of Habit',
  slug: 'mobile',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'com.mxahn.dev.toh',
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
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
  extra: {
    apiUrl: process.env.API_URL ?? 'http://localhost:3000',
    eas: {
      projectId: '1236b489-89d7-4c92-8bd3-4bbf4a48076b',
    },
  },
  owner: 'mxahn',
  scheme: 'towerofhabit',
  plugins: ['expo-router', 'expo-splash-screen'],
  experiments: {
    typedRoutes: true,
  },
});
