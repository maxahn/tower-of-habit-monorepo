# Mobile Development Guide

## Prerequisites

- Node 24.x (see `.nvmrc`)
- pnpm 9.x+
- EAS CLI: `npm install -g eas-cli`
- An [Expo](https://expo.dev) account, logged in via `eas login`
- For iOS device builds: an Apple Developer account linked in Expo

## Local Development

```bash
pnpm install
pnpm -F mobile dev        # starts Expo dev server
```

Press `i` for iOS Simulator or `a` for Android Emulator. For a physical device, scan the QR code with the Expo Go app or a development client build.

The dev server connects to the local API at `http://localhost:3000` by default. Start the API with:

```bash
pnpm dev:api
```

## Build Profiles

All builds use [EAS Build](https://docs.expo.dev/build/introduction/). Run from the monorepo root with `-F mobile` or from `apps/mobile` directly.

| Profile         | Command                              | Target                           | API URL                            |
| --------------- | ------------------------------------ | -------------------------------- | ---------------------------------- |
| `dev`           | `pnpm -F mobile build:dev`           | Physical device (internal)       | `http://localhost:3000`            |
| `dev:simulator` | `pnpm -F mobile build:dev:simulator` | iOS Simulator / Android emulator | `http://localhost:3000`            |
| `staging`       | `pnpm -F mobile build:staging`       | Physical device (internal)       | `https://staging.towerofhabit.com` |
| `production`    | `pnpm -F mobile build:production`    | App Store / Play Store           | `https://api.towerofhabit.com`     |

### Platform-specific builds

Append `--platform ios` or `--platform android` to build for a single platform:

```bash
pnpm -F mobile build:dev -- --platform ios
```

### Installing dev builds

After a successful build:

1. **iOS device**: EAS emails a link, or run `eas build:list` and open the build URL. Install via the QR code or direct download.
2. **iOS Simulator**: `eas build:run --profile dev:simulator --platform ios`
3. **Android**: download the `.apk` from the build URL and sideload it, or use `eas build:run --profile dev --platform android`.

The dev client connects back to your local Expo dev server. After installing, start the dev server (`pnpm -F mobile dev`) and the app will pick it up automatically on the same network.

## OTA Updates (expo-updates)

Staging and production builds receive over-the-air updates via EAS Update. The `runtimeVersion` uses the `fingerprint` policy — updates are compatible as long as the native project hasn't changed.

```bash
pnpm -F mobile update:staging       # push an update to the staging channel
pnpm -F mobile update:production    # push an update to the production channel
```

Updates are checked automatically on app launch (`checkAutomatically: 'ON_LOAD'`).

### When to use OTA vs. a new build

- **OTA update**: JS/asset-only changes (bug fixes, copy, styling, new screens).
- **New build**: native dependency changes (new Expo SDK, new native module, config plugin changes).

The `fingerprint` runtime version policy handles this automatically — if native code changes, the fingerprint changes and old builds won't receive the update.

## Environment Variables

| Variable  | Where set              | Purpose                     |
| --------- | ---------------------- | --------------------------- |
| `API_URL` | `eas.json` per profile | Base URL for the API server |

The value flows through `app.config.ts` → `expo-constants` → `Constants.expoConfig.extra.apiUrl` at runtime.

## Troubleshooting

- **"Network request failed" on physical device**: the device must reach your dev machine. Use your LAN IP instead of `localhost` — Expo's dev server prints the URL on start.
- **Metro bundler cache**: `pnpm -F mobile dev -- --clear` to reset the cache.
- **EAS build fails on iOS**: ensure your Apple Developer account is linked in Expo (`eas credentials`).
