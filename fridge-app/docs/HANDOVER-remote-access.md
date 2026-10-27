# Handover — unattended remote access to the fridge fleet

**The requirement, stated by Siggi and treated as hard:** he must be able to take
over a machine's screen on his own initiative, without an operator present and
without asking anyone to press anything. Shell access alone would be sufficient
in principle, but screen access is what unlocks everything.

This is the one capability the project does not have, and three attempts at it
have failed.

---

## Why the current approach doesn't work

**Tailscale has failed three distinct ways**, each fixable, each needing someone
at the machine — which defeats the purpose:

1. It wasn't installed on Siggi's Mac at all, while the tailnet appeared to be
   routing (another node was answering).
2. A machine showed **connected in the Tailscale console while not passing
   traffic** — ping timed out, other tailnet devices answered fine. Likely
   Android battery optimisation suspending the VPN while the coordination server
   still sees a heartbeat.
3. Even when the route works, **adb needs wireless debugging**, whose port is
   randomised on every reboot. Reading the new port needs eyes on the screen.

`adb tcpip 5555` fixes the port but does not survive a reboot, and a Device Owner
app cannot re-arm it — that needs system-level access we don't have.

**What HAS worked reliably:** the app's own outbound channels. OTA, the command
queue (~5s to reach a machine), and the log relay (logcat posted to the backend
every 5 min, readable from the dashboard). None need an inbound connection, a
port, or a VPN. These are not the gap.

**TeamViewer QuickSupport has worked every time it was needed** — it survived a
reboot when adb over Tailscale did not. But it requires the operator to open it
and accept, which is exactly the dependency Siggi wants removed.

---

## The path worth testing

**TeamViewer Host, not QuickSupport.** Host is the product for unattended access:
assign the device to a TeamViewer account once and it stays in the device list.
QuickSupport always requires confirmation.

**The obstacle is remote CONTROL on Android.** Screen viewing is one thing;
clicking is another. Android requires an add-on plugin — a Universal Add-On or a
vendor-specific one — enabled in Accessibility settings before the remote mouse
can inject touches. TeamViewer's own documentation is explicit that if a
confirmation pop-up appears on connecting, that device is not compatible with
unattended access.

That is the live risk: these are generic Weimi boards (WM3.0ZL controller,
Android 11) with no vendor add-on likely to exist. The Universal Add-On may or
may not work.

**Device Owner may close exactly that gap.** The add-on needs an accessibility
service enabled, and a Device Owner app can write `enabled_accessibility_services`
through `DevicePolicyManager.setSecureSetting`. Our app IS Device Owner on
provisioned machines. So the app could enable TeamViewer's add-on silently at
provisioning, with no operator ever opening Settings.

**Unverified, and must be tested before anything is built on it:**

- Does TeamViewer Host connect to these boards without a prompt?
- Which add-on does it ask for, by package and service name?
- Does `setSecureSetting(ENABLED_ACCESSIBILITY_SERVICES, …)` actually take on
  Android 11 on this hardware?
- Unattended Android access is a **paid** TeamViewer feature — confirm the
  licence before designing the fleet around it.

---

## The test to run first

On the machine physically in front of Siggi:

1. Install **TeamViewer Host** (not QuickSupport).
2. Assign it to his TeamViewer account.
3. Connect from his Mac. **Does it prompt on the machine, or connect straight
   through?**
4. Note the exact add-on it requests, if any.

That single test decides whether this approach is viable at all. If Host prompts
and the add-on can't be enabled, the answer is a different tool — and the
alternatives worth considering then are building screen capture into our own app
(Device Owner can grant a lot, though MediaProjection consent is its own
problem), or accepting operator-assisted access and investing instead in making
the machine self-diagnosing.

---

## Context you need

**App v0.49.0 / versionCode 124.** Three machines live plus one at Siggi's
location:

| Machine | Type | State |
|---|---|---|
| `8626020618` | single | Nordic Hostel, selling |
| `8626020619` | single | provisioned, healthy |
| `8626020716` | double | cabinet A + most of B reporting; 5 modules silent, with Weimi |

**The admin sheet** (`AdminClock.kt`) is PIN-gated (`123456`) and already the
operator's console: device code, last successful poll, system clock, Settings,
Wi-Fi, kiosk toggle, dev-bar toggle, and TeamViewer launch/download buttons. Any
new support tooling belongs here — it is reachable on a kiosk with no navigation
bar and needs no laptop.

**A related piece of work is queued:** operator self-service provisioning, so a
new machine can be set up without Siggi on adb. See
`HANDOVER-operator-provisioning.md`. The two overlap — whatever remote-access
mechanism is chosen should be installable as part of that flow.

**Read the memory files** (`gravity-fridge-app`, `-backend`, `-ui`, `-infra`) —
they are authoritative and current.

---

## How to work well here

**Instrument before theorising.** Days have been lost to plausible theories
diagnosed from the shape of a previous bug. Cabinet B was declared unwired for two
days when its modules were simply at addresses 20–35 rather than 16–31. Add the
log first and ask Siggi for one run.

**Check what a number means before reasoning from it.** Sixteen trays reading
exactly `0g` was read as broken hardware; it meant "not asked".

**Siggi is at the machine and you are not.** He is technically sharp, patient, and
consistently right about the machine's behaviour when he pushes back. A wrong
instruction can cost him a drive across the country.

**Every ask goes in a numbered list at the very bottom of the message.** Commands
in copyable code blocks, always with the full adb path
`~/Library/Android/sdk/platform-tools/adb`.
