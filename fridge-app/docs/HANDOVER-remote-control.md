# Handover — remote control of the fridge fleet

**What Siggi needs:** to take over a machine on his own initiative — screen, shell,
or both — without an operator present and without a laptop on the same network.
He has stated this is a hard requirement. Today it does not exist, and the gap
has cost several days.

App is at **v0.50.2 / versionCode 130**. Read the memory files
(`gravity-fridge-app`, `-backend`, `-ui`, `-infra`) — they are authoritative.

---

## What works, and is not the problem

These are outbound-only. No inbound connection, no port, no VPN. They have never
failed except when the machine's own backend link was down:

- **Command queue** — reaches a machine in ~5s. Live commands:
  `fridge_open_door`, `scale_read`, `scale_calibrate`, `scale_tare`, `tare_all`,
  `read_all_trays`, `read_temp`, `set_cooling` / `set_temp`, `sync_price_tags`,
  `check_update`, `restart_app`, `launch_support`. Allow-listed globally on the
  backend — a new machine inherits them automatically.
- **OTA** — proven end to end. Requires Device Owner (see below).
- **Log relay** — the app posts its own logcat to the backend every 5 minutes,
  readable from the dashboard's Controls tab. This is the single most useful
  diagnostic in the project. It has answered questions on machines that were
  otherwise completely unreachable.
- **`restart_app`** (v0.50.0) — restarts the app with no adb. Necessary because
  **a Device Owner app cannot be force-stopped**, from Settings or from adb; the
  button is greyed out and `am force-stop` silently does nothing.
- **`launch_support`** (v0.50.0) — opens TeamViewer QuickSupport on the machine's
  screen so an operator only has to accept.

---

## What does not work

**adb is not a remote channel on these boards and will not become one.**

- Android 11 wireless debugging assigns a **new random port on every reboot**.
  Reading it needs eyes on the screen.
- `adb tcpip 5555` fixes the port but does not survive a reboot, and a Device
  Owner app cannot re-arm it — that needs privileges we cannot obtain.
- Pairing over Tailscale has failed repeatedly ("protocol fault", timeouts).

**Tailscale has failed three distinct ways**, each fixable, each needing someone
at the machine:

1. Not installed on Siggi's Mac at all, while the tailnet appeared to route
   (another node was answering pings — this misled the diagnosis for a while).
2. A machine showed **connected in the Tailscale console while not passing
   traffic** — ping timed out, other tailnet devices answered fine. Suspected
   Android battery optimisation suspending the VPN while the coordination
   server still saw a heartbeat.
3. Even with a working route, adb still needs the randomised port.

**TeamViewer QuickSupport has worked every time it was needed** — it survived a
reboot when adb over Tailscale did not. But it requires the operator to open it
and accept, which is precisely the dependency to be removed.

---

## The path that was researched but never tested

**TeamViewer Host, not QuickSupport.** Host is the product for unattended access.

**The obstacle is remote CONTROL on Android.** Viewing is one thing, clicking
another. Android needs an add-on plugin — Universal or vendor-specific — enabled
in Accessibility settings before the remote pointer can inject touches.
TeamViewer's documentation is explicit that if a confirmation prompt appears on
connecting, that device is not compatible with unattended access.

**Device Owner may close exactly that gap.** The add-on needs an accessibility
service enabled, and a Device Owner app can write
`enabled_accessibility_services` through `DevicePolicyManager.setSecureSetting`.
Our app IS Device Owner on provisioned machines. So it could enable the add-on
silently at provisioning, with no operator ever opening Settings.

**Unverified, and must be tested before anything is built on it:**

- Does Host connect to these boards without prompting?
- Which add-on does it request, by package and service name?
- Does `setSecureSetting(ENABLED_ACCESSIBILITY_SERVICES, …)` take on Android 11
  on this hardware?
- Unattended Android access is a **paid** TeamViewer feature — confirm the
  licence before designing around it.

**The test:** install Host on a machine, assign it to Siggi's account, connect
from his Mac, and see whether it prompts. That single test decides whether the
approach is viable. If it prompts and the add-on cannot be enabled, the
alternatives are building screen capture into our own app, or accepting
operator-assisted access and investing in making the machine self-diagnosing.

---

## Hardware, as far as it is actually known

- **Android SBC:** Klayo K3566A (Rockchip RK3566), 2025-04-01, Android 11.
  UART1–4 broken out to green terminal blocks marked RS232 and RS485; three are
  wired. **Which UART maps to which `/dev/ttySn` has never been established** —
  worth documenting properly before wiring 44 more machines.
- **`/dev/ttyS3`** — Weimi WM3.0ZL controller: weights, locks, price tags,
  cooling. Works.
- **`/dev/ttyS4`** — Nayax Marshall payment terminal. See below.
- The Android board is the hub; the Nayax and the Weimi controller do not talk
  to each other.

---

## Open, and unresolved after two days

**Blue Hotel (`8626020716`) cannot take payment.** Our app opens ttyS4 at 115200,
calls `link.start()`, and `onReady` never fires. The terminal reports
`Roll Call V00` and `peripheral not connected`. Both devices healthy, neither
hears the other.

Ruled out: cable (verified on site), port and baud (unchanged in every build
since the Marshall code was written), device firmware (rolled back to match a
working machine exactly), and MDB flags / Payment Flags / Choose Product Timeout
(the three payment-protocol fields that changed at onboarding).

The break is bracketed precisely: two parameter dumps 84 seconds apart on
3 September, before and after Nayax onboarded the terminal. Fourteen fields
changed. `No VMC Communication` fired repeatedly from then until their firmware
push silenced the alert without fixing anything.

**Next test, planned by Siggi:** uninstall our app, run Weimi's own app against
the same terminal. If Weimi's VMC handshakes, the fault is ours. If not, it is
the terminal, with proof. This is the cleanest remaining experiment.

Also open on that machine: five silent gravity modules (cabinet B trays 32–35,
cabinet A tray 14), and a dead LED price tag at cabinet A basket 1 whose gravity
module works.

---

## How to work well here

**Instrument before theorising.** Many hours were lost to plausible theories
diagnosed from the shape of a previous bug. Cabinet B was declared unwired for
two days when its modules were simply addressed from 20 rather than 16. A single
silent serial read — on a port our own app was actively polling — was treated as
evidence of a hardware fault and pulled a whole day's diagnosis the wrong way.

**Check what a number means before reasoning from it.** Sixteen trays reading
exactly `0g` meant "not asked", not "broken".

**Siggi is at the machine and you are not.** He is technically sharp and has been
right about his own machines when he pushed back — more than once against
confident advice. When his account of events conflicts with an inference from
logs, weight his account heavily.

**Every ask goes in a numbered list at the very bottom of the message.** Commands
in copyable code blocks, always with the full adb path
`~/Library/Android/sdk/platform-tools/adb`.

**A related handover exists:** `HANDOVER-operator-provisioning.md`, on letting an
operator set up a new machine without Siggi on adb. The two overlap — whatever
remote-access mechanism is chosen should be installable as part of that flow.
