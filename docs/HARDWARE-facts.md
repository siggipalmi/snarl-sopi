# Hardware facts — confirmed on machines, not assumed

Everything here was established by testing on real hardware, usually after a
plausible assumption turned out to be wrong. None of it can be inferred from
documentation or from the other machine types.

App is at **v0.54.0 / versionCode 135**.

---

## Serial ports differ by machine type. There is no pattern.

| Machine | Nayax payment | Other |
|---|---|---|
| **Gravity fridge, SINGLE cabinet** | `/dev/ttyS4` | weight bus `ttyS3` |
| **Gravity fridge, DOUBLE cabinet** | `/dev/ttyS1` | weight bus `ttyS3` |
| **Coil machine (WM55)** | `/dev/ttyS3` | motors `ttyS1` @ 9600 |

Nayax runs at **115200 8N1** on all of them.

- Double confirmed on `8626020716`, 2026-09-06.
- Single confirmed on `8626020623`, 2026-09-15.

**Do not collapse these.** The double was diagnosed first and the app default was
changed to ttyS1 for every machine on the strength of it — which would have
broken payment on every single-cabinet fridge in the fleet, including the one
taking real money at the hostel, had a single not been set up the same week and
caught it.

v0.54.0 picks the default from the planogram's cabinet count. A config value
(`paymentSerialPort`) or the `set_payment_port` command marks the port as
deliberately set and stops the cabinet-count default applying.

**What a wrong port looks like:** the port opens fine, `link.start()` succeeds,
and `onReady` never arrives. Not one received byte, ever, and no error from
either side. The Nayax reports `Roll Call V00` and `peripheral not connected`.
It is indistinguishable from a dead cable, and three days were spent on cable,
firmware and Nayax settings before the port was suspected.

---

## Gravity module addressing: cabinets are 20 apart, not 16

    cabinet A basket 1..16 -> tray 0..15
    cabinet B basket 1..16 -> tray 20..35

Each cabinet gets a **block of 20 addresses** because a cabinet can hold up to 20
baskets. Trays 16–19 exist on no machine.

Confirmed by Weimi, 2026-08-28.

**Two consequences, both of which bit:**

**The read must be two calls.** `multiReadModuleWeight(count, firstTray)` reads a
CONTIGUOUS run, so asking for 36 trays from 0 sweeps 16–19 as well. The board
burns six retries on each absent address, and that traffic browns out the bus —
on `8626020716` the cabinet lights and the compressor cycled off and on for
hours. It stopped the moment the polling stopped. The app now issues
`multiReadModuleWeight(16, 0)` and `multiReadModuleWeight(16, 20)`.

**The same arithmetic existed in two places.** `Basket.trayIndex` was corrected
and the copy in `CommandRunner.trayOf` was missed, so single-basket commands were
four baskets off on cabinet B: B1 addressed a tray that does not exist, and
**B5 landed on B1**. A tare aimed at B5 would have silently zeroed B1 and
mis-charged every later sale from it. Fixed in v0.53.1. `tare_all` was never
affected because it walks the planogram.

---

## Temperature: it was in the acknowledgement all along

    READ:  ctlTemp(address, 0, 0)     — mode 0
    WRITE: ctlTemp(address, 1, degC)  — mode 1, whole degrees, clamp 1..15

The 0x4A reply is not a bare ack. Parse the data hex string:

    [20:24]  cabinet temperature, signed 16-bit big-endian, tenths of C
    [36:38]  sub-command; the setpoint field is only valid when this is 00
    [38:40]  setpoint, whole degrees C

Signed matters below zero: `0xFFEC` is −2.0 °C, not 6553.2.

`ctrlCompressor` is **acknowledged and ignored**. The board runs its own
thermostat; the setpoint is the only way to reach it. Twelve combinations of
`ctlTemp` mode against `ctrlCompressor` were swept before anyone realised mode 0
is *read* — so the sweep never once wrote a setpoint.

Confirmed driving the compressor: cabinet went 12 °C → 10 °C and kept falling.

---

## The board's clock cannot be trusted after a power cut

Seen coming back as `2000-01-01` and `2026-12-26` on three machines this month.

**A wrong clock fails TLS silently.** The machine reaches nothing — no config, no
commands, no OTA — while running perfectly and showing the correct cached
operator details on screen. Nothing on the customer-facing UI distinguishes it
from a healthy machine. This cost most of a day on `8626020619`.

NTP corrects it within a minute or two **if automatic time is enabled**. That is
now a provisioning checklist item: Settings → System → Date & time.

v0.47.1 added device code, last successful poll and system clock to the admin
sheet so this is a ten-second diagnosis rather than a drive.

---

## Device Owner is absolute

Once set, the package cannot be force-stopped, cleared, or uninstalled — from
Settings or from adb. All three fail:

    dpm remove-active-admin -> "Attempt to remove non-test admin"
    pm uninstall            -> DELETE_FAILED_DEVICE_POLICY_MANAGER
    pm clear                -> "Cannot clear data for a protected package"

The app itself is the only thing that can surrender it, which is what
`clear_device_owner` (guarded, requires `{confirm:"yes"}`) exists for. Without it
the only route is a factory reset, which on a placed machine destroys Tailscale,
TeamViewer and wifi at once.

`restart_app` exists for the same reason — nothing external can restart a Device
Owner app, and several things only happen at startup.

Setting Device Owner fails if **any** account has been added to the device.

---

## Other things that are true and were not obvious

- **Doubles have ONE lock for both doors, by design.** Opening either opens both.
  The WM3.0ZL has a second lock header (锁2) but it is unpopulated. Driving lock 2
  put continuous traffic on the energy board — the same bus as the lights and
  compressor — and cycled both.
- **Basket numbers in commands are 1-based; tray indices in logs are 0-based.**
  Cabinet A basket 15 is tray 14. Cabinet B baskets 13–16 are trays 32–35.
- **`getTemplate` is silent** on this board at every address tried.
  `getAllDeviceStatus` returns static presence flags, byte-identical 13 minutes
  apart. `getEleInfo` (0x47) is electrical metering: energy `[18:26]`, voltage
  `[26:30]` ÷100, current `[30:34]` ÷100. Its 0x0046 field is 0.70 A, **not**
  7.0 °C — a cabinet at 25 °C proved that.
- **`probe_addresses` was withdrawn** in v0.49.1. It reported "no modules on the
  bus" in the same minute `read_all_trays` returned 27 working trays. Use
  `read_all_trays`.
- **The Weimi apps hold the serial ports.** `com.weimi.monitor` restarts
  `com.weimi.gs_vendor`, so stop the monitor first. Do **not** disable
  `com.weimi.launcher` before our app is Device Owner and set as home.

---

## How these were found, and the lesson

Almost every item above was first diagnosed wrongly. Sixteen trays reading
exactly `0g` was read as broken hardware; it meant "not asked". A silent raw read
of `ttyS4` was explained away as our own app consuming the bytes; it was telling
the truth. Nayax Core reporting no fault was read as the terminal being content;
its firmware had simply stopped raising the alert.

**Instrument before theorising, and check what a number means before reasoning
from it.** When the operator's account of events conflicts with an inference from
logs, weight the account heavily — it was right every time.
