# Welcome to your Expo app 👋

This is an [Expo](https://expo.dev) project created with [`create-expo-app`](https://www.npmjs.com/package/create-expo-app).

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Start the app

   ```bash
   npx expo start
   ```

In the output, you'll find options to open the app in a

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

## Run on the Android emulator (NixOS)

This project uses the native module `modules/copyparty-sha512`, so Expo Go is not supported — you need a dev build. The emulator + AVDs are managed on the host via Android Studio; the repo's `flake.nix` provides the build toolchain (JDK 17, Gradle, Android SDK, NDK, CMake).

One-time host setup (NixOS only, symlink so the macOS-style SDK path resolves):

```bash
mkdir -p ~/Library/Android && ln -sfn ~/Android/Sdk ~/Library/Android/sdk
```

Each run:

1. Start an AVD from any shell (Android Studio manages AVDs):

   ```bash
   emulator @<AVD_NAME>
   adb devices   # confirm the emulator shows as `device`
   ```

2. Enter the dev shell and build + install the app:

   ```bash
   nix develop
   npm run android
   ```

   This runs `expo run:android` (prebuild → Gradle build → install APK on the emulator → start Metro) and auto-launches the dev client on the emulator.

Notes:

- First Gradle run downloads the distribution; `flake.nix`'s `shellHook` primes `~/.gradle/wrapper/dists/...` and bumps the wrapper's `networkTimeout` to 600s. If priming fails, the shell prints the exact `curl` command to retry.
- Subsequent iterations only need Metro: `npm start` from inside `nix develop`.

You can start developing by editing the files inside the **app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## Get a fresh project

When you're ready, run:

```bash
npm run reset-project
```

This command will move the starter code to the **app-example** directory and create a blank **app** directory where you can start developing.

## Learn more

To learn more about developing your project with Expo, look at the following resources:

- [Expo documentation](https://docs.expo.dev/): Learn fundamentals, or go into advanced topics with our [guides](https://docs.expo.dev/guides).
- [Learn Expo tutorial](https://docs.expo.dev/tutorial/introduction/): Follow a step-by-step tutorial where you'll create a project that runs on Android, iOS, and the web.

## Join the community

Join our community of developers creating universal apps.

- [Expo on GitHub](https://github.com/expo/expo): View our open source platform and contribute.
- [Discord community](https://chat.expo.dev): Chat with Expo users and ask questions.
