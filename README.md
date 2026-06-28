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

## Running the app (NixOS)

This project uses the native module `modules/copyparty-sha512`, so Expo Go is **not** supported — you need a dev build. The emulator + AVDs are managed on the host via Android Studio; the repo's `flake.nix` provides the build toolchain (JDK 17, Gradle, Android SDK, NDK, CMake). iOS simulator is macOS-only and not covered here.

One-time host setup (NixOS only, symlink so the macOS-style SDK path resolves):

```bash
mkdir -p ~/Library/Android && ln -sfn ~/Android/Sdk ~/Library/Android/sdk
```

### 1. Start the Android emulator

The reliable launch path is **Android Studio → Device Manager → ▶ on an AVD**. The SDK's `emulator` binary is an unpatched FHS ELF, so launching it from a plain shell fails with `libX11.so.6: cannot open shared object file`. (Alternative: `emulator @<AVD_NAME>` works from any shell *only after* you add the X runtime libs to `programs.nix-ld.libraries` — see the lib list in `CLAUDE.md`.)

Then confirm it's booted:

```bash
adb devices                            # expect: emulator-5554   device
adb shell getprop sys.boot_completed   # 1 when the OS is ready
```

### 2. Build & launch the dev build

Enter the dev shell and sanity-check you're in it — if `which java` prints nothing you are **not** in the devShell and the build will fail with `JAVA_HOME is not set`:

```bash
nix develop
which java        # must print a path
npm run android   # expo run:android: prebuild → Gradle build → install → Metro → launch
```

Or run it in one shot from outside the shell:

```bash
nix develop --command bash -c 'npm run android'
```

Notes:

- First Gradle run downloads the distribution; `flake.nix`'s `shellHook` primes `~/.gradle/wrapper/dists/...` and bumps the wrapper's `networkTimeout` to 600s. If priming fails, the shell prints the exact `curl` command to retry.
- Subsequent iterations only need Metro: `npm start` from inside `nix develop`.

### 3. Bring up the copyparty test server

The app talks to a [copyparty](https://github.com/9001/copyparty) server. A Dockerized one is provided for local dev:

```bash
npm run test:integration:up     # starts copyparty/ac:latest on :3923, waits for healthcheck
npm run test:integration:down   # tear down (-v also drops the persisted volume for a clean slate)
```

It exposes a single account `test` / `testpw` with full access to one volume. Connect using:

| From | URL |
| --- | --- |
| Host (curl, browser) | `http://127.0.0.1:3923` |
| **Android emulator (the app)** | `http://10.0.2.2:3923` |

`10.0.2.2` is the Android-emulator alias for the host's loopback. In the app, add a Server pointing at `http://10.0.2.2:3923` with user `test` / password `testpw`. Host-side sanity check:

```bash
curl -u test:testpw "http://127.0.0.1:3923/?ls=/"
```

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
