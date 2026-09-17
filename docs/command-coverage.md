# Command coverage — backend allow-list vs. what the fridge app implements

Backend `CMD_TYPES` (`router.js`) against `CommandRunner.execute`
(`fridge-app/app/src/main/java/.../data/backend/CommandRunner.kt`), as of
backend v6.31.1 and app v0.54.0 / versionCode 135, 2026-09-17.

**The structural problem this table exists to surface:** `CMD_TYPES` is
allow-listed *globally*, so every machine is offered every command, and a
build that does not implement one answers `unsupported` and stops there.
Nothing on the dashboard distinguishes "did it" from "silently didn't".
`CommandRunner` records the precedent in its own comments — the dashboard
sent `set_temp`, the app implemented `set_cooling`, and every temperature
command was answered `unsupported` while the Controls tab looked fine. It
was caught "only in the relayed log, and only because we happened to read
it."

---

## Implemented (15)

`fridge_open_door`, `scale_read`, `scale_calibrate`, `scale_tare`,
`tare_all`, `read_all_trays`, `read_temp`, `set_cooling` / `set_temp`,
`sync_price_tags`, `check_update`, `restart_app`, `clear_device_owner`,
`set_payment_port`, `launch_support`.

`probe_addresses` is explicitly answered as withdrawn rather than falling
through, which is the right shape for a retired command.

## Gaps that matter for fridges (4)

| Command | What pressing it does today |
|---|---|
| `set_led` | Answers `unsupported`. Confirmed on `8626020623`. Spec in `app-contract-set_led.md`. |
| `set_machine_key` | Answers `unsupported`. **The fridge fleet cannot receive a key push at all.** |
| `restart_machine` | Answers `unsupported`. The dashboard offers reboot-machine separately from restart-app (`router.js:2408`); only the app half exists. |
| `defrost` | Answers `unsupported`. The cooling endpoint offers `defrost` alongside `set_temp`/`set_cooling` (`router.js:2417`); only the latter two exist. |

`set_machine_key` is the one with consequences beyond a dead button. The
backend already has no safe remote key rotation (see CLAUDE.md), and this
closes the remaining door: even a backend that could mint a new key while
the old one still validates would have nothing on the fridge side to receive
it. Rotating a placed fridge's key is a site visit today, and will stay one
until this lands. That is worth knowing before 44 more machines are placed.

`restart_machine` and `defrost` are the same failure mode as
`set_cooling`/`set_temp`: a control that exists on the dashboard, looks like
it worked, and does nothing.

## Not gaps — coil concepts (6)

`clear_aisle_fault`, `set_aisle_enabled`, `test_vend`, `dispense_log`,
`query_channel_status`, `set_drop_sensor`. Aisles, channels, drop sensors
and test vends belong to the spring-coil machines. `config_health` is also
absent and reports `undecodableAisles`, so it reads as coil-oriented too —
worth confirming rather than assuming.

Note that the allow-list itself does not enforce this. Only some handlers
validate machine type: `fridge_open_door` and the `scale_*` family check
`fridgeSpec` and refuse a cabinet the machine does not have. The rest are
offered to everything.

---

## The cheap fix for the whole class

Whatever else happens, the app could answer `unsupported` with the command
name *and* a list of what it does handle. The backend already stores every
verdict verbatim, so one richer refusal string would turn "nothing
happened" into a readable answer in the dashboard, for every future command
the two sides disagree about — without either side knowing in advance which
one that will be.
