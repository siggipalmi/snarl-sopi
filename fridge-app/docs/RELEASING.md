# Releasing a fridge build

## The usual path

1. In the change's pull request, bump **both** in `app/build.gradle.kts`:
   `versionCode` (+1) and `versionName`. The updater only installs a higher
   `versionCode`, and CI skips a version that is already released.
2. Merge to `main`. The `release` workflow builds, runs the unit tests, signs
   with the fleet key and attaches `snarl-fridge-<versionName>.apk` to a
   `fridge-v<versionName>` release on `siggipalmi/snarl-sopi`. The release notes
   list the commits since the previous fridge release.
3. In the dashboard, **App updates → ↓ load latest fridge build**. It fills the
   version code, name and APK url and shows the notes.
4. Choose who gets it — a canary list first, then all machines — and press
   **publish**. Machines pick it up on their next update check (≤ 60 min).
5. Watch the fleet table. A machine that crash-loops on the new build reverts
   itself and shows `rejected`; **halt rollout** on the Fridge card stops the
   rest.

Nothing reaches a machine until step 4.

## Signing: the one thing that can break this

Android installs an update only if it is signed with the same key as the
installed app. Every machine runs a debug build signed with the
`~/.android/debug.keystore` on Siggi's Mac, so CI signs with that same file,
stored as the `DEBUG_KEYSTORE_BASE64` secret. A build signed with any other key
fails to install on every machine, silently from the dashboard's point of view.

CI writes that keystore to a file and points `FLEET_DEBUG_KEYSTORE` at it, which
`app/build.gradle.kts` uses for debug signing; on the Mac the variable is unset
and the default keystore is used. After the build, the workflow checks the
**APK's own certificate** against the fleet's (`FLEET_CERT_SHA256`,
`c3d1dfdb…4a746f52`) and refuses to release on a mismatch. Checking the
keystore file alone is not enough: on 2026-10-01 the file was right and the
runner signed with a key of its own anyway.

The workflow log prints the key's SHA-256 fingerprint. It must match:

```
keytool -list -v -keystore ~/.android/debug.keystore -storepass android -alias androiddebugkey | grep SHA256
```

## Secrets (repo Settings → Secrets and variables → Actions)

| Secret | What |
|---|---|
| `DEBUG_KEYSTORE_BASE64` | `base64 -i ~/.android/debug.keystore` |
| `SNARL_SOPI_RELEASE_TOKEN` | fine-grained token, `siggipalmi/snarl-sopi` only, Contents: read and write |

## By hand, if CI is down

```
./gradlew assembleDebug
gh release create fridge-v<versionName> app/build/outputs/apk/debug/app-debug.apk \
  --repo siggipalmi/snarl-sopi --title "fridge v<versionName>" \
  --notes "versionCode: <versionCode>"
```

The `versionCode: N` line is what the dashboard's load button reads.
