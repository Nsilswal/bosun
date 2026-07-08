# Releasing the Bosun app

The app needs native modules (camera, secure store, mDNS, push), so it does
**not** run in Expo Go. You need a **dev client** build installed on your
device. This doc covers the dev build (the bar for the current slice) and the
TestFlight / Android internal-testing path (documented, not required yet).

## Prerequisites

- An [Expo account](https://expo.dev) — free.
- `npm i -g eas-cli` and `eas login`.
- For iOS device builds: an Apple Developer account ($99/yr) and the device
  registered for internal distribution. For the iOS **Simulator** you need
  neither (set `"simulator": true` under `build.development.ios`).
- Run everything below from `apps/mobile`.

## One-time project setup

```sh
cd apps/mobile
eas init            # creates the EAS project, writes extra.eas.projectId
eas device:create   # register your iPhone for internal distribution (iOS only)
```

`eas init` writes `extra.eas.projectId` into the app config. Push notifications
are gated on that id being present (see `src/push.ts`), so before it runs the
app works fully over the live connection, just without push.

## Dev build on your own device (the slice-1 target)

```sh
# iOS (physical device, internal distribution):
eas build --profile development --platform ios

# iOS Simulator instead (no Apple account needed):
#   set build.development.ios.simulator = true in eas.json, then the same command

# Android:
eas build --profile development --platform android
```

EAS builds in the cloud and gives you a QR/URL to install the dev client.
Then start the JS bundler and open the dev client:

```sh
npx expo start --dev-client
```

Scan the Metro QR from inside the installed dev client (not the camera app).
The app boots to the pairing screen.

### End-to-end smoke test

1. On your laptop: `npx bosun` (or `pnpm --filter @bosun/supervisor dev`) in a
   workspace. It prints a pairing QR.
2. In the app, scan that QR. It pairs and attaches to the live session.
3. Send a prompt that triggers a `Bash` command — an approve/deny card appears;
   approving unblocks the agent. A `git push` is hard-denied and shown as such.

Phone and laptop must be on the same LAN for this slice (LAN-direct transport).

## TestFlight (iOS) — documented target, not this slice

```sh
eas build --profile production --platform ios
eas submit --profile production --platform ios
```

`eas submit` uploads to App Store Connect. From there, add the build to a
TestFlight group. First upload usually needs the app record created in App
Store Connect (bundle id `dev.bosun.app`) and export-compliance answered
(Bosun uses only standard/exempt encryption — the app-layer NaCl handshake).

## Android internal testing — documented target

```sh
eas build --profile production --platform android
eas submit --profile production --platform android   # to a Play internal track
```

Requires a Google Play Console account and a service-account key configured for
`eas submit` (see the EAS submit docs).

## Notes

- `dev.bosun.app` is a placeholder bundle id / package name. Change it in
  `app.json` (`ios.bundleIdentifier`, `android.package`) to one you own before
  submitting to either store.
- Over-the-air JS updates (EAS Update) are not wired up yet; each native change
  needs a new build.
