# App contract — fridge lighting (`set_led` + the `led` config block)

What v0.55.0 has to implement for the dashboard's lighting panel (backend
v6.29–v6.31) to do anything. Written from the backend, which is the
authority on every shape below.

**Status:** `8626020623` on v0.54.0 answered *"this build does not handle
'set_led'"* on 2026-09-17. That verdict is recorded as `ledcap:8626020623`
and the panel now shows the loud "cannot" banner. Nothing else is blocking.

---

## 1. The command — instant override

    type:   "set_led"
    params: { brightness: <whole number 0-100> }

`0` is off. The backend normalises and rejects anything else before it
queues (`ledLevel`, `router.js`), so the app can trust the value.

This is an **instant override** for testing the wiring or lighting a
machine up to restock. It is not durable: the app returns to the config
policy on the next config apply. Exactly the relationship
`set_aisle_enabled` has with the durable `disabledAisles`.

## 2. The config block — durable policy

Arrives in the machine config as `led`. The backend normalises every field
and fills every default, so **it is always complete and correctly typed**.
The app should never have to defend against a half-filled policy.

    led: {
      mode:       "off" | "on" | "schedule",   // default "on"
      brightness: 0-100,                        // default 100; the lit level
                                                // outside any night window
      night: null | {
        from:      "HH:MM",      // 24h
        to:        "HH:MM",      // never equal to `from` — rejected at the API
        brightness: 0-100,
        timezone:  "<IANA>",     // default "Atlantic/Reykjavik"
        requiresClockProof: true
      },
      wake: {
        enabled:     true|false, // default true
        brightness:  0-100,      // default 100
        holdSeconds: 0-600,      // default 45
        trigger:     "door_unlock"   // fixed, not settable
      }
    }

`mode: "schedule"` is what makes `night` meaningful. `wake.trigger` is
always `door_unlock` because the app drives the lock and is the only thing
that knows when it fires.

## 3. `requiresClockProof` — the one that is easy to get wrong

Always `true`, and sent explicitly so the rule travels with the policy
rather than living in someone's memory.

**The app must hold the day level until it has had one successful poll.**
These boards come back from a power cut with the clock wrong, and a wrong
clock fails TLS silently — the machine reaches nothing while looking
perfectly healthy. A night window evaluated against a wrong clock dims a
machine at the wrong time of day, and nothing on screen says why.

One successful poll proves the clock. Until then: day level, whatever the
schedule says. This is not hypothetical — `8626020623` sat with a wrong
clock on 2026-09-17, showing its device code and collecting no commands at
all, and it is the third machine this month.

## 4. Answering

`POST /api/v1/machines/:deviceCode/commands/:id/result`

    status: "ok" | "failed" | "unsupported"     // nothing else is accepted
    detail: "<string>"                           // optional, free text

**First result wins** — the handler is idempotent and a repeat for a
finalised id is a no-op. Answer once.

A `set_led` answer is the **only** signal that a machine can drive its
lights. The `led` config block is ignored silently by a build that does not
implement it, so without an answer a schedule can look saved and do nothing
indefinitely. `handleCommandResult` records every verdict to meta as
`ledcap:<deviceCode>`, the machine detail endpoint exposes it as
`ledCapability`, and the panel renders it above every control:

    never tested  quiet line pointing at the test buttons
    working       quiet green line with the date
    cannot        loud warning carrying the machine's own words

## 5. What is NOT settled here

The Weimi calls. The handover names `ctlLed` and `ledBrightnessAdjustment`
as the methods to drive, but their signatures, address handling and reply
parsing are app-and-SDK side and **are not known from this repository** —
do not guess them. Establish them on the bench fridge the way the 0x4A
temperature reply was established: drive it, log the raw reply, read what
actually came back.

Worth remembering while doing so: `ctrlCompressor` is acknowledged and
ignored by this board, and `getEleInfo`'s 0x0046 field is amps, not
degrees. An acknowledgement is not proof that anything happened. Confirm
the lights physically changed before believing a verdict of `ok`.
