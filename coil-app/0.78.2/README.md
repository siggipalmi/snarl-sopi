# Snúður & Sopi — Android vending app

Touchscreen app for Weimi WM55 spring-coil vending machines, running on
rk3566 Android 11 tablets. Designed for the Icelandic market.

This is **v0.1 — first runnable build**. The customer flow works
end-to-end with a sample catalog, but the hardware adapters (Weimi SDK,
Nayax payment) are not yet wired up. You can install this, run it on an
emulator or tablet, and click through every screen.

## How to open in Android Studio

### 1. Extract the zip somewhere

Anywhere on your computer. Inside you'll find a folder called
`snudur-sopi/` containing `build.gradle.kts`, `settings.gradle.kts`,
the `app/` module, and so on.

### 2. Launch Android Studio

On the Welcome screen click **Open** (not "New Project").

In the file picker, navigate to the `snudur-sopi/` folder you just
extracted. Select the folder itself (not a file inside it). Click **Open**.

When prompted "Trust Project?", click **Trust Project**.

### 3. Let Gradle sync

You'll see a yellow bar at the bottom: *"Gradle sync started"*.

**The first sync downloads about 200MB of dependencies** (Gradle itself,
Kotlin compiler, Compose, OkHttp, Jackson, Material3, etc.). On a fast
connection this takes 3-8 minutes. Be patient — the progress bar at the
bottom shows what's happening.

**If sync fails with "could not find gradle-wrapper.jar":** Android Studio
needs to regenerate the wrapper. Click **File → Sync Project with Gradle
Files**. If that doesn't help, open Terminal in Android Studio
(View → Tool Windows → Terminal) and run:

    gradle wrapper

This regenerates the missing jar in 30 seconds. Then re-sync.

### 4. Run on the emulator

Once sync finishes (yellow bar at the bottom disappears):

1. Pick a device from the device dropdown next to the green ▶ button.
   If no devices exist, click **Device Manager** → **Create Device** →
   pick "Pixel 8" or similar → Next → pick an "API 34" system image with
   a green checkmark → Next → Finish.
2. Click the green ▶ **Run** button.

First build takes 2-3 minutes. The emulator launches, your app appears
showing the **browse screen** with the Icelandic greeting and a grid
of real products from your live machine.

### 5. Click through the flow

- Tap any product → **product detail** screen
- "bæta í körfu" → goes back to browse with the product highlighted
- Tap basket icon (top right) → **basket screen**
- "greiða" → **payment handoff screen**
- Tap the animated arrow → **success screen** (auto-returns after 8s)
- Tap the contact icon → **contact overlay**
- Tap the "IS" language pill → cycles to EN, layout stays identical

## What's working

- Full customer flow (browse → detail → basket → payment → success)
- IS + EN string resources
- Contact overlay with operator email + machine ID
- Dynamic greeting based on time of day
- Featured products (Ísey skyr + Fylkis brúsi have bronze dots)
- Sold out state (Oat King chocolate is greyed out with "uppselt" tag)
- In-basket card indicator (dark border, "í körfu" subtitle)
- Basket cap at 5 items
- Auto-return to browse after success screen

## What's stubbed

- **Product images** are colored rectangles. Real images come once we
  wire up Coil + the Weimi API's `imageUrl` field.
- **Ad region** is a static fallback Fylkir gradient. Real version
  cycles images/video uploaded by operators.
- **Hero tiles** not yet wired in — domain model exists, UI deferred to
  next iteration.
- **Payment** is fake — tapping the arrow simulates a successful payment.
  Real version waits for Nayax callback through the Weimi serial bridge.
- **Hardware dispense** is fake — success screen just shows. Real version
  sends INSTRUCT_SHIPMENTS to the Weimi control board via /dev/ttyS3.
- **Admin access** (long-press clock for TOTP) — wired but no-op for now.
- **First-run setup** — `SetupScreen` exists but isn't connected to the
  nav graph. Currently every launch goes straight to browse with sample
  data.

## File layout

    snudur-sopi/
      build.gradle.kts            — root build file
      settings.gradle.kts         — project settings
      gradle.properties           — JVM args, etc.
      gradle/wrapper/             — Gradle wrapper
      gradlew, gradlew.bat        — wrapper scripts
      app/
        build.gradle.kts          — app module deps + config
        proguard-rules.pro
        src/main/
          AndroidManifest.xml     — permissions, activity, launcher intent
          java/is/snudursopi/vending/
            MainActivity.kt       — Compose host activity
            VendingApp.kt         — Application subclass
            BootReceiver.kt       — auto-launch on boot
            domain/               — pure Kotlin: Product, Money, Basket, etc.
            api/                  — Weimi API client (signing, models, http)
            data/                 — DataStore device identity, sample catalog
            ui/
              theme/              — colors, typography, theme wrapper
              state/              — VendingViewModel + state
              nav/                — Routes + NavGraph
              components/         — StatusBar, ActionButton, ProductCard
              screens/            — browse, detail, basket, payment, ...
          res/
            values/, values-en/   — strings.xml in IS + EN
            mipmap-*dpi/          — launcher icons at 5 densities

## Next milestones

- Wire `SetupScreen` into the nav graph; only show browse after the
  operator enters a device code.
- Real product images via Coil from `Product.imagePath`.
- Hero tile composable + scheduling (operator chooses products and dates).
- Real ad region with image/video rotation via Media3 ExoPlayer.
- Long-press clock → TOTP admin entry → admin panel.
- Wire `WeimiApiClient` to load catalog at startup, replacing
  `SampleCatalog`.
- Add hardware adapter (Weimi serial SDK in `/app/libs/*.aar`) + dispatch
  on payment success.
- Sound on success (gentle "ding"?), accessibility audit.
- Real Cormorant Garamond + Geist TTFs in `res/font/` to replace
  system serif/sans fallbacks.

## Known issues you'll see

- **The launcher icon has a tiny bronze dot.** That's intentional, it's
  the editorial accent. Not a rendering bug.
- **Gradle wrapper jar not bundled.** Android Studio will auto-fetch it
  on first sync. If it complains, see Step 3 above.
- **No fonts in res/font/.** The app uses Android's built-in serif and
  sans fallbacks, which look fine but aren't the final Cormorant +
  Geist pairing. Will swap once we ship licensed TTFs.
- **Sample catalog uses real product names** from your live machine
  photo (Ísey, Happy Hydra, Corny Big, Oat King, Powerade, Pagen,
  Fylkis Brúsi, Golfkúlur). When you wire up the real API, those will
  be replaced with whatever's in your Weimi portal.

If the app doesn't build or run, copy any error message and I'll
diagnose it next session.
