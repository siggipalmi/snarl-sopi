## v0.50.5 — close-the-bay (manual out-of-service) (2026-06-13)

Siggi: machines can still error w/o a sensor (e.g. broken motor). Wanted the
operator to CLOSE A BAY remotely. Chose MANUAL only (no auto-disable on
repeat failure). SDK has NO board-level "disable aisle" command (only locker-
door locks), so close-bay is KIOSK-ENFORCED in software (hide + refuse sale).

ADDED THIS BUILD:
- Catalog.forCustomerDisplay(... , disabledAisles: Set<String>=emptySet()):
  both overloads now filterNot { slot.uppercase() in disabledAisles }.
- ConfigClient: parses hardware.disabledAisles (array of friendly codes) into
  Loaded.disabledAisles. (hardware.dropSensor already parsed in v0.50.4.)
- VendingViewModel: @Volatile disabledAisles set, populated from config
  (source of truth) on every load; passed to both forCustomerDisplay sites.
  buyNow/addToOrder GUARD: refuse a product whose slot is closed.
  set_aisle_enabled command {aisle,enabled}: updates in-memory set for INSTANT
  effect + rebuildVisibleProducts(); config remains durable truth next poll.
- Contract addendum v0.5 updated: hardware.disabledAisles config field +
  set_aisle_enabled command + B.6 rationale (kiosk-enforced, board can't;
  backend MUST write config on close or next poll re-opens the bay; money-
  safety already handled by partial settlement). Memo updated to match.

Backend TODO (their half): dashboard close/open-bay button -> PUT .../hardware
writes disabledAisles AND optionally queues set_aisle_enabled for instant.

Still pending: query_channel_status live test (v0.50.4) + deviceCode mismatch
(doc 62160476 vs test machine 62160492 — confirm before testing).

UNVERIFIED compile; touched files brace/paren balanced.
## v0.50.4 — machine command queue: query_channel_status loop (2026-06-13)

Backend shipped contract v0.5 (backend v4.80): /config returns
hardware.dropSensor; command queue endpoints live (GET commands, POST
result), 5-min expiry, first-result-wins, issuedBy logged. They want a first
end-to-end test: query_channel_status on a NON-sensor machine to surface the
real channelStatus shape.

KIOSK WIRING THIS BUILD (minimal, per backend's test list):
- ConfigClient: parses hardware.dropSensor ("on"/"off"/absent->off) into Loaded.
- WeimiHardwareController: setInfraredState(open) [INSTRUCT_INFRARED_SET];
  queryAllChannelStatusBlocking(addr=0, windowMs=2500) -> collects RAW channel
  frames (INSTRUCT_INQUIRE_ALL/ONE_CHANNEL) for the window, returns verbatim
  data strings. SDK is Kotlin w/ default params, so 1-2 arg calls compile.
- MachineCommandsClient (new): fetchPending(deviceCode) GET
  /api/v1/machines/{dc}/commands -> data.commands[]; postResult(dc,id,body)
  POST .../commands/{id}/result.
- VendingViewModel: applies dropSensor to board on config load + motor-up
  (desiredDropSensorOn, applyDropSensorIfPossible). runPendingCommands() pulls
  + runs commands on the config poll (immediate pass at start + every 2 min;
  expiry is 5 min so safe). executeCommand handles query_channel_status (raw
  frames into channelStatus), set_drop_sensor (setInfraredState + update
  desired), else status:"unsupported". Idempotent via executedCommandIds;
  motor-not-up commands DEFERRED (left pending) not failed. HW calls on IO.

TEST: motor address = 0 (same as dispense). Watch:
  https://snarl-sopi-production.up.railway.app/api/v1/debug/commands?deviceCode=<DC>
*** DEVICE CODE MISMATCH ***: backend doc says deviceCode=62160476 but our test
machine (Valhusaskoli) is 62160492. Confirm with backend which is right before
testing, or enqueue+watch will not match. Kiosk build is deviceCode-agnostic.

AFTER TEST: send result.channelStatus JSON to backend chat -> they build the
faulted-aisles dashboard view to that exact shape. clear_aisle_fault behavior
(does resetShipment re-open a faulted aisle?) still needs a machine WITH a
sensor — deferred (queue/protocol already live).

UNVERIFIED compile; all touched files brace/paren balanced.
## v0.50.3 — coil mapping CONFIRMED + offline-sales diagnostic (2026-06-12)

MAPPING CONFIRMED ON HARDWARE: tapped A21 -> coil 21 turned, product (loaded
ONLY in coil 21) dropped. friendlyToRaw = (R-1)*10 + (9-C) is correct; friendly
code == physical coil number. Stage 3b is end-to-end working: instant buy,
correct dispense, partial settlement, decline handling (no loop), idle timeout,
no crash. (Real charges 539/539/299 went through; later declines were bank
velocity on the repeated test card, not a bug.)

OFFLINE SALES — design done (offline-sales-plan.md). Scope: Case A only (queue
the sale RECORD when our WiFi is down; card money clears via Nayax's own modem
regardless). Case B (terminal/acquirer down) = machine shows ReaderDown
takeover (already built, auto-clears). Sales reported via Weimi notify-shipment
(WeimiApiClient.notifyShipment, already exists; recordTransaction does NOT call
it yet — this feature wires it + adds offline queue mirroring ComplaintRepo).

BLOCKING unknowns before building: payChannelCodeInt (card) + userId for
notify-shipment. THIS BUILD adds a diagnostic to read them from a real order:
- WeimiApiClient.queryOrdersRaw(page,size,deviceCode) -> raw JsonNode.
- VendingViewModel.dumpRecentOrders() -> logs pretty raw JSON of last 10 orders
  for this device (chunked for logcat). Read: adb logcat -s VendingViewModel:I.
- Diagnostics screen: new row "skrá pantanir í logcat" (⤓) -> onDumpOrders.
Run it, read payChannelCodeInt + userId + aisle-code shape off a real card sale,
then we build SalesRepository/queue.

UNVERIFIED compile; all touched files brace/paren balanced.
## v0.50.2 — fix coil column reversal; double-tone is a real card decline (2026-06-12)

TWO findings from E2E test + Nayax DEX log:

FIX — COIL COLUMN REVERSED. v0.50.1 sent raw=(R-1)*10+(C-1); A22->coil28,
A21->coil29 (wrong, empty coils). A5 worked only by coincidence (col5 is the
middle: 9-5==5-1==4). The board counts coils RIGHT-TO-LEFT (raw0=coil9), and the
operator's friendly code equals the physical coil number (A21=coil21). So column
maps as (9-C), NOT (C-1). FIX: friendlyToRaw = (R-1)*10 + (9 - C). Verified by
math: A21->coil21, A22->coil22, A35->coil35, A5->coil5 (friendly == coil #).
First real dispense per row confirms.

NOT A BUG — DOUBLE-TONE DECLINE. Nayax internal DEX shows "VEND Auth. Declined"
+ host contacted (Resp time 550ms) -> real acquirer decline. Timing: the 3
SUCCESSFUL real charges (539,539,299) came first, then all declines -> classic
bank velocity/fraud protection after rapid repeated real-money charges on ONE
card. Not random per-product; temporal. App decline handling works (shows try-
again, re-arms ONCE, no loop). Test with a different card or space out charges.

CONFIRMED WORKING in this test (v0.50.1): loop GONE (decline re-arms once),
idle-timeout cancels to browse, partial-settlement captures (539/539/299), no
crash. Only the column-reversal remained; fixed here.

TEST v0.50.2: tap A21 -> must turn coil 21 (right product). Tap a few across
rows/cols. Use a FRESH card to avoid the velocity decline. Confirm right product
each time.
## v0.50.1 — fix double-conversion coil bug + re-send loop (2026-06-11)

v0.50.0 E2E test found TWO bugs:

BUG 1 — WRONG COIL (double conversion). Tapping A26 turned coil35, A37→45,
A25→34 (wrong products). Root cause: MotorInstruct.setShipments(slot) ALREADY
applies raw→coil internally (in STIG we typed RAW numbers and the right coil
turned). But friendlyToCoil ALSO did raw→coil, so the value got converted
TWICE. Confirmed: friendlyToCoil(A26)=24 → setShipments re-converts 24→coil35 =
what turned.
FIX: replaced friendlyToCoil with friendlyToRaw = (row-1)*10+(col-1) — ONE
conversion; pass the RAW index to setShipments and let the board do raw→coil.
orderItems() now uses friendlyToRaw. (A26→raw15, A37→raw26, A25→raw14.)
Still verify E2E — the first dispense of a known slot confirms it.

BUG 2 — RE-SEND LOOP. Editing/declining caused "sending repeatedly to Nayax,
never caught up, stuck until manual cancel." Root causes: (a) armReader used a
fixed 400ms delay then charged regardless of controller state; (b) onPaymentResult
auto-re-armed on EVERY Declined immediately — and a no-card-tap surfaces as
Declined — so cancel→decline→re-arm→cancel looped.
FIX:
 - armReader now: bumps an armSeq, cancels, then awaitReady() polls the
   controller State until READY (timeout 4s) before chargeBasket; stale/
   superseded arms (mySeq != armSeq) bail; an `arming` guard prevents overlap.
 - onPaymentResult Declined: show "try again", then re-arm ONCE after 1200ms,
   and only if order stands, phase still Declined, and not already arming.
 - Cancelled result: NO auto re-arm.
 - cancelOrder() bumps armSeq + clears arming so in-flight arms are abandoned.

Also seen in test (explained, expect fixed now): timeouts sending back to browse
(idle 10s — working as designed), and the loop (bug 2).

TEST: stop Weimi. Tap a KNOWN slot (e.g. the A26 product) → confirm the RIGHT
product/coil turns now. Tap card → success. Then: edit qty (debounce re-arm,
should settle, no loop), decline/no-tap (→ try again, single re-arm after pause),
cancel, idle. Watch logcat -s VendingViewModel:I MarshallPay:I for "item is in
session" (should be gone) and the dispense coil lines.

UNVERIFIED compile. VendingViewModel + SlotCodeTranslator balanced; no
friendlyToCoil refs remain.
## v0.50.0 — Stage 3b: real payment wired into the customer flow (2026-06-11)

Stage 3a (partial settlement + crash fix) DONE + soak-passed (3 back-to-back
txns, charged 20 for 2/3, no crash). This build wires the PROVEN chargeBasket
into the real customer experience. INSTANT-BUY model.

DESIGN (all Siggi-approved, mockup-first):
- Tap a product on the grid → goes STRAIGHT to the pay screen for that 1 item,
  and the Nayax is armed IMMEDIATELY (no "pay" button). Single-item = 2 touches
  (tap product, tap card).
- Pay screen = running order: per-line +/-, "add more" (→ grid, next tap
  appends), total, small cancel. NO pay pill.
- Order edits → debounced (~1.5s) cancel + re-send fresh amount to Nayax.
- Decline/no-tap → "payment cancelled, try again", order kept, AUTO RE-ARM.
- Reader down → dedicated error screen ("machine is fine, reader reconnecting"),
  AUTO-CLEARS when onReady fires again.
- 10s idle on awaiting-card → cancel + back to browse.
- Capture only what vended (partial settlement engine from 3a).

SLOT→COIL MAPPING (proven empirically on 62160492, see slot-to-coil-mapping.md):
friendly "A<r><c>" → raw=(r-1)*10+(c-1) → coil=(0 if rawRow==0 else 10*(rawRow+1))
+ (9-rawPos). Sanity A35→coil35. Added SlotCodeTranslator.friendlyToCoil().
⚠ UNVERIFIED end-to-end — FIRST REAL DISPENSE confirms it; wrong coil = adjust
the one formula.

FILES:
- SlotCodeTranslator: friendlyToCoil().
- VendingViewModel: now takes appContext; owns MarshallPaymentController +
  WeimiHardwareController; startHardwareOnce() on Ready (reader always-on);
  PaymentPhase enum + readerReady on VendingState; buyNow/addToOrder/inc/dec;
  scheduleRearm (debounce) + armReader (cancel→settle 400ms→chargeBasket);
  onPaymentResult (Approved→record+Done; Declined/Failed→Declined+auto re-arm);
  startIdleTimeout (10s); cancelOrder; resetPaymentPhase; onCleared disconnects.
- MarshallPaymentController: onReaderStateChanged hook (fires onReady true /
  onCommError false) for the reader-down screen.
- PaymentScreen: full rewrite — phase-driven merged order+live-reader, no pay
  pill, +/- per line, add-more, declined banner, reader-down takeover.
- NavGraph: product tap → buyNow → Payment; phase-driven nav (Done→Success,
  Idle→Browse); reset phase on Success.
- VendingViewModelFactory: pass appContext.
- strings (IS/EN): pay_reader_live, pay_arming, pay_dispensing, pay_declined,
  pay_reader_down_*, pay_charged_only. PLACEHOLDER wording — polish pass later.

⚠ RISKS to watch in E2E test (build whole flow at once per Siggi):
1. cancel→re-send cycle: armReader cancels then waits 400ms before chargeBasket.
   If "item is in session" appears, increase the settle delay or wait for the
   controller state to return to READY explicitly.
2. friendlyToCoil: first dispense confirms A35→coil35.
3. reader-down auto-clear timing.
4. The big rewrite may have compile errors — clean them as they come.

TEST: stop Weimi. Build, install. Tap a product → pay screen + reader live →
tap card → dispense → success. Then: add more, edit qty (watch debounce
re-arm), decline (no tap → try again), cancel, idle 10s. Confirm coil matches
product. Wording polish is a SEPARATE later pass (Siggi has notes).

NEXT after E2E passes: wording polish pass; then provisioning/kiosk-mode/offline.

UNVERIFIED compile (big change). All touched files brace/paren balanced; XML
valid; zero backslashes. Sandbox cannot compile — expect possible fixes.
## v0.49.9 — FIX crash: thread-safe logging (2026-06-10)

🎉 v0.49.8 PARTIAL SETTLEMENT WORKS — basket auth 30, 2/3 vended, card charged
20. Confirmed on real hardware. Stage 3a COMPLETE.

THEN: after a couple successful txns the APP CRASHED, leaving a stuck/open
session on the terminal (beep + swipe graphic, won't proceed = "item is in
session").

CRASH ROOT CAUSE (from logcat):
  java.lang.IndexOutOfBoundsException: index: 41, size: 41
  at SnapshotStateList.removeAt
  at HardwareTestScreen.kt:489 (marshallLog trim)
  at MarshallPaymentController.emit (the SDK logger hook)
  at com.bitmick.marshall...ClientHandlingRunnable.run (SDK's OWN thread)
The verbose SDK logging we added (v0.49.1, logger.aux) runs on the SDK's
background thread. It called emit() → marshallLog.add + while(size>40)removeAt
on a Compose SnapshotStateList. Motor callbacks + dispense thread also wrote.
Multiple threads mutating the list raced (size check vs removeAt) → IOOBE →
uncaught on SDK thread → process crash. The crash then left the Marshall
session open (the stuck-terminal symptom).

FIX: added a single thread-safe logLine() helper that posts every write onto
the MAIN thread via Handler(Looper.getMainLooper()), then trims. Replaced ALL
~15 direct marshallLog.add/removeAt sites (SDK log hooks, motor.start, dispense
+ result callbacks) with logLine(). clear() stays (button-click=main thread).
Now no cross-thread mutation → no race → no crash. Payment logic UNCHANGED.

STUCK SESSION RECOVERY (for the terminal right now):
  adb shell am force-stop isl.snudursopi.vending.debug
  power-cycle the VPOS (or wait for V00 then recover)
  relaunch app → connect → wait onReady → retest.

TEST: install v0.49.9. Run several STIG 3a cycles back-to-back (the crash
appeared after 2 txns — the log list filling past 40 lines + SDK thread was the
trigger, so multiple cycles now is the real soak test). Should NOT crash.
Confirm partial settlement still charges 20.

Stage 3a DONE once this soak passes. NEXT: Stage 3b — wire chargeBasket into the
real BrowseScreen→basket→PaymentScreen→Success flow (currently only in the
hardware test harness; completePayment() in VendingViewModel is still a
placeholder).

UNVERIFIED compile. Balanced; all log writes now main-thread; no marshallLog.add
remains outside logLine.
## v0.49.8 — fix quantity bug: explicit vend_item qty=1 (Option B) (2026-06-10)

v0.49.7 sequencing fix WORKED (approve-fast + background dispense+close; no more
bounce; "session_close → capturing 20" fired). BUT card still settled 30, and
the SDK log showed:
  "Vend End Session, prod: 30, price: 20, quantity: 30"
  "marshall_t: final price: 600"   (= 20 × 30)
ROOT CAUSE: our 0.1.5.25 (SIBS) vend_session_t ctor builds a product whose
QUANTITY = the total (30), so price*qty was wrong and the terminal fell back to
the original auth (30). (Weimi uses 0.1.6.10 with different ctors: (SIBI),
vend_item_t(SIIB) — version mismatch.)

OPTION B FIX (patch 0.1.5.25): build the basket session from an EXPLICIT
vend_item_t with qty=1 (not the (SIBS) ctor):
- chargeBasket: list=[vend_item_t(code=0, price=total, qty=1, unit)],
  vend_session_t(list), set total_amount/vend_amount/funds_avail=total.
- dispenseBasketAndClose: set products_list[0].price=capturedSum AND qty=1,
  vend_amount/total_amount/funds_avail=capturedSum, then session_close.
Goal: price*qty = capturedSum (e.g. 20×1=20), not 20×30.

TEST (DCS already matched to working machine: timeout 20, MDB flags 4098):
stop Weimi. STIG 3a A=8,B=8,C=99,price=10. connect → fjölkaup → tap ONCE.
Watch SDK log: "Vend End Session" should show price:20 quantity:1 (not 30),
"final price: 20" (not 600). CHECK BANK: settled 20?

If STILL wrong (e.g. quantity persists or final price off): the version
mismatch is the blocker → ask Weimi for the 0.1.6.10 SDK (matches their app +
your DCS). This Option B is the quick attempt before that.

Note: Nayax didn't show the settled amount on its screen (only bank app shows
it) — may be a display config, separate from the capture amount issue.

UNVERIFIED compile. Balanced; vend_item_t qty:I/price:S public settable;
ctor (SSIB) matches.
## v0.49.7 — fix sequencing: approve fast, dispense+close in background (2026-06-10)

Sigurður provided a WORKING Weimi machine's full DCS export (machine 62160484).
Two findings:

DCS (working machine):
- Choose Product Timeout = 20 (NOT 0 — the docs' "0" was wrong; 20 is real).
- MDB flags = 4098 (Preselection Enabled + Cancel when no vend success).
- MDB Level 3 Optional Features include "Basket/Partial Refund" + "Always Idle".
- Capabilities = 320. Multivend = Disabled. Decimal Place = 0.
=> Sigurður is matching the TEST machine (62160492) DCS to these.

CODE (this build): found via Weimi APK that NayaxKitImpl.onVendApproved just
returns true IMMEDIATELY — it does NOT dispense in the callback. Our code did
the whole dispense loop (incl. 8s dead-slot timeout) INSIDE onVendApproved,
blocking the SDK callback thread → preselection window collapses → bounce.

FIX: restructured basket flow to match Weimi:
- onVendApproved (basket) → spawn a background Thread that does dispense +
  session_close, and RETURN TRUE immediately (don't block the callback).
- New dispenseBasketAndClose(session): dispenses each item, sums vended,
  sets session.vend_amount/total_amount/products_list[0].price = vended sum,
  session_status = ok (or fail_to_dispense if 0), then session_close to
  capture the reduced amount.
- onSettlement simplified: finalizes Result.Approved(capturedAmount) (close
  already happened in background). Removed basketNeedsClose.

Config unchanged (already matches Weimi: always_idle=true, price_not_final=true,
multi_session=true, multi_vend=false).

TEST (after DCS matched + terminal polled): stop Weimi. STIG 3a A=8,B=8,C=99,
price=10. connect → fjölkaup → tap ONCE. Preselection should now STAY (timeout
20). Approve is instant; dispensing runs in background (8,8 ok + 99 times out);
session_close captures 20. CHECK CARD: 20? Watch SDK: "final price"/"Vend
Success" — should be 20.

UNVERIFIED compile. Balanced; session_status_* verified; background Thread
pattern; no dangling refs.
## v0.49.6 — Option 3: single-session basket + price-not-final (2026-06-10)

v0.49.5 multi-vend WORKED for transmission (VPOS asked 30, "Vend Multi-Success
products:3 total:30") BUT captured the FULL 30 — setting vend_amount in
onVendApproved did NOT reduce it ("final price: 30"). 

SDK constraint discovered in docs (line 331): multi-vend "only supported with
a single session; multisession+multivend NOT supported." And partial capture
(price_not_final) correlates with MULTI-SESSION. So multi-vend CANNOT do
partial capture — they're mutually exclusive. Confirmed real Nayax limitation.

Sigurður chose Option 3: single-session basket + price_not_final.
Mechanism (from docs + demo handle_close_session):
- price_not_final_support=true → preselection behaves as pre-auth; final
  amount captured at session_close, not at authorization.
- multi_session_support=true (docs: correlates w/ price_not_final).
- multi_vend_support=false (NOT multivend).
- Basket = ONE vend_session_t for the TOTAL. Authorize total → tap once →
  onVendApproved: dispense all items, sum vended → set session amount
  (vend_amount/total_amount/products_list[0].price) to vended sum +
  session_status_ok_e → session_close(session) on settlement captures the
  REDUCED amount.

NEW: chargeBasket(items) + basket state + onVendApproved basket branch +
session_close in onSettlement. onDispenseItem hook reused. Stage 3a test now
calls chargeBasket (was chargeMulti).

⚠ DCS REQUIREMENT (docs line 334-338): multi-session/price-not-final needs DCS:
"MDB flags: 02 Preselection Enabled" + "Choose product timeout: 0". If not set,
partial capture may not work even with correct code. MAY need to ask Nayax/DCS
admin. We'll test first to see.

TEST: stop Weimi. STIG 3a: A=8,B=8,C=99,price=10. connect → fjölkaup → TAP CARD.
VPOS shows 30 → tap → dispense 8,8 ok + 99 fail → session_close → 
CHECK CARD: charged 20 (partial works!) or 30 (price_not_final needs DCS)?
Watch SDK: lines for "final price" — should be 20 now.

If still 30: DCS config needed (Preselection Enabled + timeout 0), escalate.
If 20: Option 3 works → Stage 3b wires into real basket flow.

UNVERIFIED compile. Both files balanced; session_close/session_status_ok_e/
chargeBasket verified vs bytecode; products_list null-guarded.
## v0.49.5 — FIX multi-vend: enable multi_vend_support (2026-06-10)

v0.49.4 SDK packet trace (via the new logger hook) cracked it:
  "vmc_vend_t: Vend Request, product: 0, price: 10"
The SDK transmitted only the FIRST item (product 0, price 10), not the 3-item
list / 30 total. So the terminal correctly showed 10 — it never saw a basket.

ROOT CAUSE: cfg.multi_vend_support was FALSE in connect(). With it false, the
SDK ignores the multi-item products_list and sends only the first product.
(The earlier "asked for 10" was this, not DCS — multi-vend IS enabled in DCS.)

FIX: cfg.multi_vend_support = true.
Kept always_idle=true (single-tap UX, proven) + direct vend_request(listSession)
— the v0.49.4 trace showed the direct path does fire a vend_request; with the
flag on it should now send the full list + summed total.

NOTE: v0.49.4 multi attempt ended Declined (no charge) — so no money lost; but
that was incidental. Re-test needed.

⚠ WATCH after this fix:
- Does single-item charge() (Stage 1/2, uses vend_session_t(SIBS) not a list)
  still work now that multi_vend_support=true? If it misbehaves, route single
  charges through a 1-item list too (unify paths). Stage 1/2 previously passed
  at multi_vend_support=false.
- Does the VPOS now show 30 (the full basket)?

RE-TEST: stop Weimi. STIG 3a: A=8,B=8,C=99,price=10. connect → fjölkaup.
Look in SDK: lines for "Vend Request" — should now show the basket total (30)
and/or multiple products. VPOS should show 30. Dispense 8,8 ok + 99 fail →
expect capture 20 (partial via vend_amount). CHECK CARD: 20?

(Earlier resource-compile saga resolved in v0.49.4: reworded 7 strings to drop
apostrophes entirely — aapt rejected both \' escapes AND &#39; entities in
this AGP. Zero backslashes/entities now.)

UNVERIFIED compile. Balanced.
## v0.49.1 — multi-vend DIAGNOSTIC: capture SDK packet dump (2026-06-10)

v0.49.0 multi-vend test: our app-side logic was correct (log showed "2/3
vended → capturing 20") BUT the VPOS only ASKED FOR 10 and charged 10 — i.e.
the terminal saw one item's price, not the 30 total. So the authorization
amount sent to the terminal was wrong (10, not 30).

Investigation (bytecode):
- vend_item_t(SSIB) ctor mapping confirmed CORRECT: code,price,qty,unit. Our
  items (price=10,qty=1 each) are built right.
- vend_session_t(ArrayList) ctor only stores products_list; does NOT set
  total_amount.
- BUT vmc_vend_t.handleMessage DOES read products_list price*qty and writes
  total_amount/vend_amount — so the SDK is supposed to sum internally.
- Multi-vend IS enabled in the DCS (confirmed by Sigurður). So not a server
  config issue.
- Could not determine from static analysis WHY the terminal got 10. Need the
  SDK's own packet dump to see the actual amount on the wire.

THIS BUILD adds the diagnostic: hooked logger.aux(log_aux_i) + 
logger.level(LOG_LEVEL_EVERYTHING) in connect() → routes ALL SDK internal
logging (incl. Marshall packet dumps with the amount bytes) into our
marshallLog view, prefixed "SDK:". Verified logger API vs bytecode
(aux(log_aux_i)V, log_aux_i.log(String)V, level(I)V, LOG_LEVEL_EVERYTHING).

RE-TEST (same as 3a, now with packet visibility): stop Weimi. STIG 3a:
A=8,B=8,C=99,price=10. connect → fjölkaup → tap. Now the log will show
"SDK:" lines with the actual vend_request packet + amount. Look for: what
total does the SDK put in the vend message? 30 or 10? And how many products
in the packet? That pinpoints whether the list is summed before sending.

Likely fixes once we see the dump:
- If SDK packet shows 10/one product: the list isn't being processed as
  multi-vend (maybe needs session_start first, or always_idle interferes with
  multi-vend, or a config flag). 
- If packet shows 30 but VPOS still charges 10: terminal/DCS multi-vend
  behavior — escalate to Nayax.

NOTE: still charges a real card. Small amounts, own card, bench.

UNVERIFIED compile. Balanced; logger API verified.
## v0.49.0 — Stage 3a: multi-vend partial settlement test (2026-06-10)

Stages 1+2 PROVEN incl. the v0.48.1 safety fix (capture only on VENDED;
NO_RESPONSE/timeout voids — verified on slot 99). Now test Sigurður's basket
model: charge whole basket, settle ONLY for items that vended.

Sigurður confirmed VPOS is in PRE-AUTHORIZATION mode (required for multi-vend).

NEW (MarshallPaymentController):
- data class Item(code, slot, priceIsk)
- chargeMulti(items, onResult): builds ArrayList<vend_item_t>, one
  vend_session_t(list), vend_request → VPOS shows TOTAL, single tap.
- onVendApproved multi path: dispenses each item via onDispenseItem hook,
  counts vended, sets session.vend_amount = sum of vended items' prices
  (partial capture), returns true if anything vended else false (void all).
- onDispenseItem hook (per-item dispense → bool).
- finish() clears pendingItems/multiSession.
Verified vs bytecode: vend_item_t(SSIB)=(code,price,qty:int,unit), 
vend_session_t(ArrayList) ctor, vend_amount is public settable short.

HardwareTestScreen: new "STIG 3a — fjölkaup + hlutgreiðsla" section. 3 slot
fields (A,B good + C dead=99), price field. "1 · opna báða + connect" opens
motor+marshall and wires onDispenseItem→dispenseBlocking (VENDED→true).
"2 · fjölkaup" calls chargeMulti with 3 items.

⚠ THE UNPROVEN HYPOTHESIS: partial capture via setting vend_amount <
total_amount. The demo never does partial — always returns true + full
capture. THIS TEST DECIDES if the model works.

TEST: stop Weimi. STIG 3a: A=8, B=8, C=99, price=10 (total 30).
"1 · opna báða + connect" → onReady. "2 · fjölkaup" → VPOS shows 30 → tap
ONCE → dispenses 8,8 (ok) + 99 (fail) → should capture 20, NOT 30.
CHECK THE CARD: charged 20? Then partial works. Charged 30? vend_amount
ignored — need fallback (refund diff via RUFUND_RESULT, or per-item sessions).
Charged 0 / declined? multi-vend or pre-auth not behaving — check logs.

If 20 → model proven → Stage 3b wires into real basket→pay→success.

UNVERIFIED compile. Both files balanced; all multi-vend SDK calls verified
against jar bytecode; Box import present.

## v0.48.1 — SAFETY FIX: void on dispense timeout / no-response (2026-06-10)

CRITICAL BUG found by Sigurður's invalid-slot test (slot 99, no motor):
the board never acked → dispenseBlocking TIMED OUT → returned UNKNOWN → my
Stage 2 rule "capture unless MOTOR_FAILED" CAPTURED the charge. Card charged
10 kr for NO product. This is exactly the charge-without-product failure we
must never have.

ROOT CAUSE: conflated "timeout / no board response" with "ambiguous parsed
code". A timeout means the board didn't respond at all → the dispense almost
certainly did NOT happen → must VOID, not capture.

FIX:
- New DispenseResult.Outcome.NO_RESPONSE for the timeout case.
- dispenseBlocking() returns NO_RESPONSE on timeout (was UNKNOWN).
- Capture policy tightened to the safest rule: CAPTURE ONLY on VENDED
  (confirmed motor turn). Everything else — MOTOR_FAILED, NO_RESPONSE,
  ORDER_REJECTED, UNKNOWN — VOIDS the charge.
  Rationale: a wrongly-voided real vend just means the customer retries; a
  wrongly-captured failure = charged-for-nothing, which we must avoid.

NOTE: this machine has NO active infrared drop sensor, so "empty slot but
motor turns" still reports VENDED → captures (uncatchable by hardware;
complaint flow is the backstop). The void path now correctly fires for
motor failures AND no-response/timeouts.

Also noted (not fixed here, for Stage 3): tapping "charge" before onReady
gives "Failed(not ready CONNECTING)" — correct (no charge) but the real
PaymentScreen should disable pay until ready (D4 in stage3-plan).

RE-TEST: STIG 2, slot=99 (no motor), amount=10. Expect
"dispense outcome=NO_RESPONSE" → charge VOIDED → card NOT charged.
Then a loaded slot → VENDED → charged. Both paths must be correct now.

Stage 3 plan written (stage3-plan.md) — awaiting decisions (esp D1: single-
item vs multi-item card payment to start).

UNVERIFIED compile. Balanced (code-only), no exhaustive when on Outcome
elsewhere, NO_RESPONSE only produced by dispenseBlocking.

## v0.48.0 — Marshall payment Stage 2: charge + dispense (both ports) (2026-06-10)

Stage 1 (v0.47.1) PROVEN: real card charged, correct single-tap flow, V00
clears, decimal_place=0. Now couple the dispense.

Sigurður's decisions: charge-first-then-dispense (SDK default); on dispense
FAIL return false → terminal voids/refunds (no charge without product).

DISPENSE SUCCESS JUDGEMENT (reuses existing DispenseResult philosophy):
motor-mechanical axis only — drop sensor is disabled fleet-wide (flaky IR
false-negatives). So:
  VENDED (motor turned)            → return TRUE  → capture charge
  MOTOR_FAILED (motor didn't turn) → return FALSE → void/refund
  UNKNOWN / ORDER_REJECTED         → return TRUE  → capture (motor likely
     turned; complaint flow is the backstop for rare genuine misses)
i.e. refund ONLY on MOTOR_FAILED.

NEW (WeimiHardwareController):
- dispenseBlocking(addr, slot, timeoutMs=8000): DispenseResult — fires
  setShipments and BLOCKS on a CountDownLatch until the board ack arrives
  (released in the receiver callback when cmd==INSTRUCT_SHIPMENTS), or times
  out (→ UNKNOWN). Needed because onVendApproved must decide true/false
  synchronously on the SDK thread.

MarshallPaymentController: onApprovedDispense hook (set in Stage 2 test) is
called inside onVendApproved; its boolean return drives capture vs void.

HardwareTestScreen: new "STIG 2" section. "1 · opna báða + connect" opens
motor on ttyS1@9600 AND marshall on ttyS3@115200 simultaneously, wires
onApprovedDispense → motor.dispenseBlocking(slot) → outcome!=MOTOR_FAILED.
"2 · charge + dispense" runs a real charge that, on approval, dispenses the
slot. Slot field provided.

⚠ KEY TEST CONCERNS:
- BOTH ports open at once (ttyS1 motor + ttyS3 marshall) — does the motor
  dispense disrupt the Marshall session? (different ports/libs, should be
  independent — VERIFY on bench).
- onVendApproved BLOCKS on the SDK thread up to 8s waiting for the motor —
  watch the Marshall session survives the block (keep-alive is the SDK's, on
  ttyS3; the block is on our latch waiting for ttyS1).
- Use a slot that actually has product + a real card.

TEST: stop Weimi. STIG 2: slot=<a loaded slot>, amount=50.
"1 · opna báða + connect" → wait onReady + "motor ttyS1 open=true".
"2 · charge + dispense" → VPOS shows 50 → tap card → onVendApproved →
dispense → motor turns → product drops → Approved(50). Card charged, product
out. Try a KNOWN-EMPTY/jammed slot too to see refund path (MOTOR_FAILED→void).

NEXT (Stage 3): wire into real basket→pay→dispense behind PaymentProcessor.

UNVERIFIED compile. Balanced; onApprovedDispense public var; DispenseResult
outcomes valid; imports present. dispenseBlocking must run off main thread
(it's called from the SDK callback thread — OK).

## v0.47.1 — fix payment flow: always_idle (display price → single tap) (2026-06-10)

Stage 1 on v0.47.0 SUCCEEDED in charging a real card, but the FLOW was wrong:
customer had to tap to wake the VPOS, THEN it showed the amount, THEN tap
again (2 taps). Also a spurious "RESULT: Failed(AWAITING_CARD)" appeared
mid-flow (state race) even though payment then succeeded.

ROOT CAUSE: we used always_idle=false (reader-initiated: tap→amount→tap) and
called vend_request inside onSessionBegin (after the tap). The demo shows the
correct VMC-initiated flow: set always_idle=TRUE and call vend_request(session)
DIRECTLY — VPOS displays the amount immediately, customer taps ONCE.

FIX:
- cfg.always_idle = true
- charge() now sends vend_request(session) directly (no session_start, no
  wait-for-tap). Removes the AWAITING_CARD intermediate state + the race.
- onSessionBegin no longer re-requests (it's now just "card detected" info).
- Removed unused requestVend().
Matches demo handle_start_session: if always_idle -> vend_request(session).

TEST (same as before, but expect ONE tap and amount shown FIRST):
stop Weimi. greiðsluprófun STIG 1: amount=50, connect (wait onReady), charge.
VPOS should DISPLAY 50 immediately, tap card ONCE -> Approved(50). No 2nd tap,
no spurious Failed.

NOTE for later: demo also session_close()s after vend (sets session_status_ok
+ code=0). Not needed for charge-only proof; add when wiring full flow if the
session doesn't auto-close cleanly between charges.

UNVERIFIED compile. Balanced, flow matches demo's always_idle branch.

## v0.47.0 — Marshall payment Stage 1: charge-only test (2026-06-10)

MILESTONE on v0.46.2: onReady FIRED on real hardware — our app is the Marshall
host, terminal cleared V00. decimal_place=0 confirmed (ISK 1:1, no scaling).
serial=0434331423115816, fw matches. The direct-SDK host path WORKS.

This build adds the PAYMENT layer (Stage 1 = charge only, NO dispense):
NEW: hardware/nayax/MarshallPaymentController.kt
- connect(): SDK lifecycle -> onReady (host up)
- charge(amountIsk): session_start(credit) -> onSessionBegin (card tap) ->
  vend_request(vend_session_t(total, funds, unit_general, vend)) ->
  onVendApproved -> [STAGE 1: return true WITHOUT dispensing] ->
  onSettlement(true) -> Result.Approved. onVendDenied -> Declined.
- onApprovedDispense hook (null in Stage 1) is where Stage 2 will dispense.
- One session per BASKET TOTAL (per Sigurður's choice).
- All 12 vend_callbacks_t methods overridden (verified exact sigs vs bytecode).
- vend_session_t(SIBS) = (short total, int funds, byte unit, short vend) verified.
- All vmc_configuration fields/consts verified present.

HardwareTestScreen: new "greiðsluprófun (STIG 1)" section — amount field +
connect / charge / cancel / disconnect buttons, logs to the shared marshall log.

TEST (SAFE — charges a REAL card a small amount, NO product dispensed):
1. stop Weimi app+monitor. 2. admin->vélbúnaðarpróf->"greiðsluprófun STIG 1".
3. amount=50. 4. tap "1 · connect", wait for "✅ link onReady".
5. tap "2 · charge", tap a real card on the VPOS. 6. watch for onVendApproved
   -> onSettlement -> "RESULT: Approved(50)". Card charged 50 kr, no dispense.
Logcat: adb logcat -s MarshallPay:I MarshallSerial:I

After Stage 1 proves charging: Stage 2 = set onApprovedDispense to fire the
motor dispense on ttyS1 (test BOTH ports open at once). Stage 3 = wire into
real basket->pay->dispense behind a PaymentProcessor interface.

UNVERIFIED compile (no SDK in sandbox). Checked: balanced, all callback sigs +
constructor + config fields verified against jar bytecode, LabeledField sig
matches. Reflection serial-open proven working in v0.46.2.

## v0.46.0 — REAL Marshall Java SDK integrated (serial-layer proof) (2026-06-10)

Weimi delivered the genuine Nayax Marshall Java SDK (marshall-java-sdk.jar,
v0.1.5.25) + working demo + official docs. Added the jar to app/libs (the
fileTree already includes *.jar; SDK is self-contained — no gson/jSerialComm
needed at runtime, verified).

THE PLAN: run the real SDK in OUR app as the Marshall host. The only Android
obstacle is serial I/O (demo used desktop jSerialComm). Solved by backing the
SDK's lowlevel_i interface with Weimi's OWN native serial (SerialportSocket +
libWeimiSerialPort.so, already in base-sdk, arm64 present, proven on ttyS3).

NEW FILES:
- hardware/nayax/AndroidMarshallSerial.kt — implements bitmick lowlevel_i;
  opens /dev/ttyS3 @115200 8N1 via com.weimi.serialport.SerialportSocket
  (async connect() with $b callback, then InputStream/OutputStream), read
  thread reassembles Marshall frames (len = first 2 bytes LE + 2) -> onReceive.
- hardware/nayax/MarshallProbe.kt — minimal: configure vmc_configuration
  (port ttyS3, baud 115200, machine_type beverage), set_lowlevel(our serial),
  configure, set_events, link.start(). Logs onReady (= host up, V00 clears),
  incl. decimal_place from vpos_config_t (ISK must be 0!) + fw versions.

HardwareTestScreen: new section "marshall sdk · beintenging" with start/stop +
a live log view (last 30 lines).

API verified against jar bytecode: lowlevel_i (init/register_link_events/start/
stop/reset/transmit/onLinkTimerTick), vmc_framework (getInstance/start/stop +
public fields link/vend/general/socket), vmc_link (set_lowlevel/configure/
set_events/start/is_ready), vmc_configuration fields, vpos_config_t fields
(incl decimal_place), vmc_link_events_t (onReady/onCommError). SerialportSocket
(init/connect($b)/getInputStream/getOutputStream/close, native open via .so).

TEST (THE PROOF): stop Weimi app (com.weimi + monitor) so ttyS3 is free.
admin -> vélbúnaðarpróf -> "marshall sdk · beintenging" -> start. WATCH for
"✅ onReady" in the log view AND terminal clearing V00. Also note the logged
decimal_place (MUST be 0 for ISK or prices are 100x off).
Logcat: adb logcat -s MarshallProbe:I MarshallSerial:I

RISK: first build against obfuscated Weimi SerialportSocket + the bitmick SDK.
UNVERIFIED compile (no SDK/NDK in sandbox). Checked: balanced, imports present
(added mutableStateListOf), package paths + nested type names + method sigs all
match jar bytecode, minify off (SDK not stripped), .so present for arm64.
If onReady fires, the hard part is DONE — payment flow is the documented demo.

NEXT after proof: build MarshallPaymentController (session_start -> vend_request
-> onVendApproved=dispense -> vend_status) behind a PaymentProcessor interface.

## v0.45.1 — multi-port: open ttyS3 so the SDK runs Marshall (2026-06-08)

BREAKTHROUGH from cold-launch capture of the stock Weimi app:
  MotorSerialPortKit.init -> binds a background SERVICE (motor.a.a) ->
  service opens ttyS1 AND ttyS3 -> on ttyS3 it loads the embedded
  "marshall java sdk version sdk_java_0.1.6.10" (Nayax's Marshall Java SDK!)
  -> marshall_t: reset -> fw_info -> config -> default credit 159 -> fw vers
  -> vmc_vend_t: "Reader Enable" -> vmc_socket [init]->[idle] -> mdb 0x14 poll.

So the certified Marshall host is ALREADY ON THE DEVICE, embedded in the
Weimi serial service. It auto-runs the whole reset->Reader Enable->poll
sequence on ttyS3 BY ITSELF once ttyS3 is brought up. No manual NayaxInstruct
needed to start it; the service does it.

Why our app was silent before: we only passed ttyS1 to startSerialPortKit.
The service never brought up ttyS3, so the Marshall/VMC stack never ran.

FIX (this build): WeimiHardwareController takes optional nayaxPortPath +
nayaxBaud; when set, the config array passed to startSerialPortKit includes
BOTH ttyS1@9600 (motor) and ttyS3@115200 (Marshall), matching the stock app.
HardwareTestScreen: added a "opna líka nayax port (marshall)" toggle (default
ON) + nayax port/baud fields (default /dev/ttyS3, 115200). Default motor port
changed to /dev/ttyS1.

TEST: stop Weimi. In harness, keep toggle ON (ttyS1 + ttyS3), open ports.
WATCH LOGCAT for the service to run: vmc_link port ttyS3 -> marshall_t
reset/config -> Reader Enable -> mdb 0x14. If that sequence appears and the
terminal CLEARS V00 = our app now hosts Marshall via the SDK service. THEN
sendPrice should drive a real card prompt.
Command: adb logcat | grep -iE "WeimiHardware|vmc|marshall|mdb"

If it works, this is the path: the SDK's own service is the Marshall host;
we just have to bring up ttyS3. Sidesteps both protocol RE and Nayax
enrollment (the Marshall Java SDK is embedded already).

CAUTION: still validate hard on bench. Watch for conflicts if both our app
and (accidentally) the Weimi watchdog try to own ttyS3.

UNVERIFIED build. Balanced, imports present (added Switch), constructor
params consistent. BUILD + bench-test.

## v0.45.0 — Nayax reverse-engineering harness + keep-alive (2026-06-08)

KEY FINDING: with the Weimi app stopped, the Nayax shows Error V00 (lost
host). Restarting Weimi clears it. => the terminal needs a CONTINUOUS host
session that the Weimi app maintains. A one-shot sendPrice into a V00
terminal does nothing (explains the earlier silence on ttyS3 @115200).

So the experiment is no longer "find sendPrice params" — it's "can WE hold
the session" (replicate the keep-alive). Built the tools for that:

WeimiHardwareController + HardwareController:
- Full NayaxInstruct surface now exposed: nayaxGetCardInfo (getCardMdbInfo),
  nayaxResponseReadCard, nayaxResponseAgree, nayaxSendPriceEnd,
  nayaxSendOutGoodResult (+ existing sendPrice/cancelPrice). Signatures
  verified against SDK bytecode.
- startNayaxKeepAlive/stopNayaxKeepAlive: a daemon thread that calls
  getCardMdbInfo every 200ms — the prime suspect for the keep-alive poll
  that holds the session. THE key experiment.
- Callback now logs EVERY reply with raw data string (data is String?, not
  bytes) + cmd code, incl. the extra NAYAX codes (INFO/END/OUT_GOOD_RESULT/
  RUFUND_RESULT). So we never miss a reply during RE.

HardwareTestScreen: added start/stop keep-alive buttons + getCardMdbInfo
button in the Nayax section.

TOPOLOGY (confirmed by Sigurður): Nayax = ttyS3. Separate RS232 = control
board. NayaxInstruct is in the motorserial package (same as MotorInstruct/
dispense on ttyS1) — so it MAY route via the control board, not direct to
ttyS3. Test both ports.

TEST PLAN: bench machine, not production — safe to hammer. 
1) Stop Weimi (terminal goes V00). 2) Open port, start keep-alive
(getCardMdbInfo @200ms), watch if V00 CLEARS = we're holding the session.
3) Try port ttyS1@9600 AND ttyS3@115200. 4) If session holds, sendPrice and
watch terminal. Capture all ← raw replies.
ALSO: capture the stock Weimi app's own traffic (adb logcat | grep ttyS3/
nayax/mdb) while it runs — may reveal the real protocol for free.

STRATEGIC NOTE: replicating an undocumented keep-alive for PAYMENTS is
inherently risky; bench-validate hard before any rollout. Coexistence
(Weimi holds session, we trigger via their hook) remains the safer fallback
— still awaiting Weimi's reply on whether their app exposes a payment trigger.

UNVERIFIED build. Checked: balanced, all iface methods implemented, SDK
signatures match calls exactly. BUILD + bench-test.

## v0.44.0 — bilingual migration of customer-facing screens (2026-06-07)

Sigurður reported these not translating: greeting (gott kvöld), pay pill,
checkout (payment), confirmation (success), complaint form + confirmation.
All were screens still hardcoding Icelandic. Migrated them to localized().

MIGRATED (now switch with the language toggle):
- BrowseScreen: greeting (day/evening) + subtitle + "greiða →" pay pill.
- ProductCard: "uppselt" + "í körfu" chips. Added language param; BrowseScreen
  passes state.language at the call site.
- PaymentScreen: tap-card instruction, waiting, item counts, cancel, basket
  full, add item. Added language param.
- SuccessScreen: "takk" hero, in-bin line, corner advisory, "vantar vöru?".
  Threaded language through AdvisoryBlock + ComplaintEntry sub-composables.
- ComplaintFormScreen: titles, subtitle, which-item labels, note/email fields
  + placeholders, send-failed, cancel, send. Added language param.
- ComplaintConfirmationScreen: received + sub. Added language param.

NEW STRING KEYS (both values/ IS + values-en/ EN): payment_tap_card,
payment_waiting_dots, payment_items_count(_cap), payment_basket_full,
payment_add_item, success_takk/in_bin/corner_advisory/missing_item,
complaint_* (title_single/multi, subtitle, which_single/multi, note_label,
note_placeholder, email_label, email_placeholder, email_note, send_failed,
cancel, send, received, received_sub). Most other keys already existed.

LEFT ICELANDIC-ONLY (operator/staff only — intentional): SetupScreen,
PinEntryScreen, DiagnosticsScreen, HardwareTestScreen.

NOT DONE YET: ErrorScreen — mixes customer text + operator diagnostics +
interpolated retry countdowns; more involved, wasn't in the reported list,
only shows on failure. Flagged for a follow-up if wanted.

VERIFICATION done in-sandbox: all 6 files balanced; each imports R +
localized; all referenced R.string keys exist exactly once in BOTH locales;
both strings.xml valid; all 4 signature-changed screens' call sites (NavGraph)
pass language. UNVERIFIED compile (no SDK). The recent misses were unresolved
refs / missing imports — checked imports per file this round. BUILD + verify.

## v0.43.0 — contact overlay: real operator + AG Vending ad (2026-06-07)

Mockup contact-overlay-mockup.html (approved). The info-icon overlay was
showing HARDCODED operator info; now it shows the real sub-operator from
backend config, plus an AG Vending house ad.

DATA WIRING (the actual bug):
- VendingViewModel hardcoded `val operatorName = "AG Vending"` and discarded
  the config profile. Now: ConfigResult carries `profile: ConfigProfile?`;
  fetchFeaturedFromConfig captures it; load flow sets
  settings.operatorName + settings.supportEmail from the profile (falling
  back to blank/default when absent). Poll path updates them too. 304-safe
  via lastConfig (profile rides along).
- So operator + email are now the REAL sub-operator (e.g. "AG Rekstur",
  hallo@snarlogsopi.is) from GET /config profile.

UI (ContactOverlay rewritten):
- Top: operator line "Þessi vél er rekin af <operator>" (generic fallback
  when blank) + email + machine-id fields (kept the field styling).
- Divider "í samstarfi við".
- AG Vending ad block: 3 machine photos (Coil, from squarespace URLs),
  pitch "Þetta tæki er leigt af AG Vending / Hafðu samband ef þú vilt leigja
  sjálfsala", QR to agvending.is (baked drawable) + url caption. ALWAYS shown.
- Scrollable (verticalScroll) since it's now taller.

BILINGUAL: all overlay strings via localized() (EN/IS). Removed the old
unused hardcoded contact_* string block (was duplicate keys -> would have
been a build error; caught and fixed).

INFRA:
- Moved localized() from screens/detail to a SHARED ui/util/Localized.kt so
  contact + detail (and future screens) share it. Added a formatted overload
  localized(lang, resId, vararg args) for the %1$s operator name.
- QR: generated app/src/main/res/drawable/agvending_qr.png (agvending.is).

ASSETS: machine photos load by URL at runtime (online-only; offline shows
text+QR, images blank). Acceptable per Sigurður. QR is bundled (offline-safe).

UNVERIFIED build (no SDK here). Checked: balanced, XML valid + no dup keys,
all string keys in both locales, drawable present + referenced, shared
localized import wired, ConfigProfile fields exist. BUILD + verify on machine.

NOTE: this is the FIRST broad use of localized() beyond the detail screen.
The full bilingual migration of the OTHER screens (Browse/Setup/Error/
Payment/Success/Basket/PIN) is still pending — they still hardcode IS.

## v0.42.0 — hero visual polish + removed diagnostic logging (2026-06-07)

Visual changes (mockup hero-visual-changes-mockup.html, approved):
1. Hero action buttons now MATCH the regular grid tiles — 40dp, solid ink
   cart w/ cream icon + creamshadow "i" info circle (were 30dp cream pills).
   Removed the old ActionPill helper + unused Info icon import.
2. Tag is now a bold 17sp italic serif BADGE overlaying the bottom-LEFT of
   the hero tile, in ALERT RED (#B8471F), rounded top-right corner. Replaces
   the tiny 14sp bronze tag that was in the caption row (removed from caption).

Cleanup:
- Removed the hero diagnostic logging from resolveHeroes (the Hero ok/skip/
  resolveHeroes: lines from v0.39.9). Back to the clean one-liner.

Decisions: alert red badge, bottom-left placement (Sigurður).

UNVERIFIED build (no SDK/gradle here). Structure checked: balanced, imports
clean, diagnostics gone. BUILD + eyeball the hero on the machine.

NEXT (not in this build): full bilingual migration (big — migrate all
hardcoded-Icelandic screens to the localized() system; only DetailScreen
switches with the toggle today). Energy/temp probe (hardware, v0.39.4 ready).

## v0.41.0 — product detail screen (nutrition/ingredients/allergens) (2026-06-06)

Backend brief kiosk-product-detail.md (final version: allergens/mayContain
are ARRAYS). Built the full feature:

NEW FILES:
- domain/ProductDetails.kt — ProductDetails + Nutrition models, all-optional.
  hasAnyDetail / hasAnyValue drive the fallback decision.
- data/backend/ProductDetailsClient.kt — mirrors ConfigClient. GET
  /api/v1/machines/{deviceCode}/product-details, machine-key auth, ETag/304.
  Parses products map -> Map<code, ProductDetails>. allergens/mayContain
  parsed as arrays WITH single-string back-compat (one-element list).
- ui/screens/detail/Localized.kt — localized(language, resId) helper:
  resolves string resources against the IN-APP Language toggle (not system
  locale), via a locale-overridden Context. This is the app's FIRST real
  runtime-localization helper (see note below).

CHANGED:
- VendingViewModel: ConfigResult gained productDetails; added detailsEtag +
  lastDetails (304-safe cache from day one — applying the v0.40.1 lesson).
  fetchFeaturedFromConfig now also fetches details (separate endpoint, same
  machine key) and returns them; both load flow + poll write
  state.productDetails. Details fetch failure NEVER blocks config/heroes/grid.
- VendingState: + productDetails: Map<String, ProductDetails>.
- DetailScreen: rewritten to the mockup. Photo-only FALLBACK preserved
  exactly when no details. With details: compact hero (photo + name +
  packSize pill + price), allergen pills (solid=allergens, outline=mayContain),
  nutrition table (basis in header row only, energy combines kJ/kcal,
  saturates/sugars as indented sub-rows, null rows skipped, table hidden if
  all null), ingredients block, notes caption. Scrollable.
- NavGraph: passes state.productDetails[product.id] + state.language.
- strings.xml + values-en: added detail_/nutrition_ label keys (EN+IS).

DECISIONS (from Sigurður): multi-pill from arrays; packSize pill shown when
known; basis in table header only.

LOCALIZATION NOTE (important): discovered the app has NO existing runtime
localization — every screen hardcodes Icelandic literals; strings.xml +
values-en exist but were NOT wired to the in-app toggle. The new
localized() helper is the first to actually honor state.language. Older
screens still hardcode IS. Worth a future pass to migrate them, but out of
scope here. The detail screen's labels DO switch with the toggle.

UNVERIFIED: could not compile in Claude's sandbox (no SDK / gradle network).
Structure checked (braces/parens/comments balanced, all R.string keys exist
in both locales, FlowRow OptIn scoped, all referenced Product/typography/
color fields exist). FlowRow is the one new API — stable in Compose BOM
2024.09 (foundation 1.7), OptIn added as belt-and-suspenders. BUILD + verify.

Backend dependency: /product-details endpoint must be live + populated for
62160492 to TEST. Until then, kiosk correctly shows photo-only fallback.

## v0.40.1 — FIX: 304 wiped hero + gridOrder on reload (2026-06-06)

BUG (found from user repro): after first load, hero + custom gridOrder
showed correctly. But basket -> checkout -> cancel -> home reverted to NO
hero and DEFAULT grid order.

ROOT CAUSE: returning home triggers loadCatalog again. fetchFeaturedFromConfig
sends the cached etag -> backend returns 304 Not Modified (config unchanged)
-> old code returned ConfigResult.EMPTY on 304 -> load flow then set
heroes=resolveHeroes(empty) and visibleProducts=forCustomerDisplay(empty
gridOrder) -> hero gone, grid back to slot order. First load worked only
because there was no etag yet (got 200 + full data); the SECOND load sent
the etag and got 304 -> wiped.

FIX: cache last successful config in `lastConfig: ConfigResult`. On 304,
RETURN lastConfig (reuse) instead of EMPTY. Also on transient
BackendException, return lastConfig instead of wiping (don't lose good
config on a blip). 200 updates the cache.

LESSON: 304 means "unchanged, keep what you have" — never translate it to
"empty". Any config-derived UI state must survive a 304 reload.

Test: load (hero+grid show) -> add to basket -> checkout -> cancel -> home.
Hero + gridOrder must PERSIST now.

## v0.40.0 — grid re-ordering (gridOrder from config) (2026-06-06)

Backend brief kiosk-grid-order.md: operator sets custom on-screen product
order per machine via config `gridOrder: [goodsId, ...]`, independent of
physical slots. Same pattern as hero/featured.

Built:
- ConfigClient: parse `gridOrder` (List<String> of goodsIds) from config;
  added to Result.Loaded (defaults empty).
- Catalog.kt: new `forCustomerDisplay(gridOrder)` overload — filters
  sold-out exactly as before, orders listed goodsIds first in gridOrder
  sequence, unlisted products fall to the end in default order. Empty
  gridOrder == old behavior (pure slot/displayOrder). Safe to ship.
- VendingViewModel: fetchFeaturedFromConfig now returns ConfigResult
  (featured + gridOrder) instead of just featured. Both load flow AND the
  2-min poll apply gridOrder to visibleProducts + featured to heroes.
- Sold-out hero rule (brief's "one related rule"): already satisfied by
  v0.39.9's isVisibleToCustomer check in resolveHeroes.

Verify on Valhúsaskóli (62160492): set gridOrder in portal (drag reorder),
reload app (or wait 2min poll), grid should reflect the order; sold-out
still hidden; unlisted products at end. Empty gridOrder = slot order.

NOTE: includes v0.39.9 hero diagnostic logging (Hero ok/skip lines) — kept,
harmless. Build env: wrapper jar + kotlin-bom + reflect pin all retained.

## v0.39.8 — *** ACTUAL ROOT CAUSE FOUND: orphaned /** comment opener *** (2026-06-06)

THE REAL BUG (found by bisection, confirmed by compiler — not a guess):
When defaultFeatured() was deleted from VendingViewModel.kt in v0.39.5, a
stray `/**` doc-comment opener was left behind, immediately followed by
the `/**` of defaultAdPlaylist()'s doc comment — i.e. TWO `/**` in a row.
Kotlin supports NESTED block comments, so `/** /** ... */` needs TWO `*/`
to close. With only one, the comment swallowed the ENTIRE REST OF THE FILE
— Phase, VendingState, the companion, everything below — turning live code
into one giant unterminated comment.

That is why:
- Phase / VendingState were "unresolved" though defined in-file (they were
  commented out from the compiler's view).
- VendingViewModel showed 149 errors and every CONSUMER (NavGraph, Browse,
  Diagnostics, Complaint, Success) cascaded — they import types that no
  longer existed.
- UNCHANGED files (BrowseScreen byte-identical to working v0.39.3) broke —
  because the shared types vanished.
- Brace-counting passed (braces balance; the issue was code-turned-comment,
  not unbalanced braces). grep found Phase as TEXT but compiler saw comment.

FIX: removed the orphaned `/**`. File now has 53 `/**` / 53 `*/`, balanced.

HOW IT WAS FOUND: user reported v0.39.3 builds + runs, v0.39.5 first broke.
Bisection on the real compiler:
  - bisectA (v0.39.3 + energy changes only) → BUILDS → energy innocent.
  - bisectC (+ new backend files, old VendingViewModel) → BUILDS → backend
    files innocent.
  → bug isolated to VendingViewModel v0.39.5 edits → found the `/**`.

WRONG GUESSES ALONG THE WAY (for the record, all cost time, all wrong):
iCloud eviction, Finder folder-merge, duplicate .aar fileTree, missing
gradle-wrapper.jar, JDK 21->17, kotlin-reflect 1.7.22 skew. The reflect
skew + missing wrapper jar were REAL secondary issues (wrapper jar was
genuinely missing from zips; reflect genuinely mismatched) and are now
fixed too — but NEITHER was the cause of the Phase cascade. The cause was
always the comment.

LESSONS (write these on the wall):
1. When source is "verified correct" but build fails MODULE-WIDE, and
   UNCHANGED files break, the cause is almost always (a) a classpath/
   dependency issue OR (b) something that silently removes a big span of
   code — like an unterminated/ nested comment. Check comment balance
   (count /** vs */) AND get real `./gradlew` output, EARLY.
2. ASK "did it ever build, and which version first broke?" on turn ONE of
   any build regression. That single question + bisection found this in
   ~3 builds after ~12 rounds of guessing.
3. After DELETING a function, check you didn't orphan its doc comment.
4. The IDE error LIST leads with the symptom file (NavGraph), not the root
   (VendingViewModel). Terminal `grep "^e:" | uniq -c` per file shows where
   the errors really concentrate.

Build env fixes retained in v0.39.8: gradle-wrapper.jar included in zip;
kotlin-bom 2.0.0 + kotlin-reflect 2.0.0 pin (aligns the jackson-dragged
reflect). These are correct hygiene even though not the root cause.

## v0.39.7 — ACTUAL ROOT CAUSE: kotlin-reflect version skew (2026-06-06)

After a VERY long debugging saga (many wrong turns: iCloud, folder-merge,
duplicate fileTree, missing wrapper jar, JDK 21->17 — all real-ish issues
but NONE the cause), the actual root was found via terminal `./gradlew
assembleDebug` output + `:app:dependencies`:

The compile errors were "String != String", "Long != Long", "cannot infer
type T", "Unresolved reference VendingState/Phase" — the classic signature
of INCOMPATIBLE KOTLIN METADATA on the classpath. dependencies showed every
kotlin artifact converging to 2.0.0 EXCEPT:
    org.jetbrains.kotlin:kotlin-reflect:1.7.22
pinned old, dragged in transitively by jackson-module-kotlin:2.17.2.
kotlin-reflect 1.7.22 metadata against the 2.0.0 compiler/stdlib corrupts
type resolution MODULE-WIDE — which is why the symptom looked like
VendingViewModel.kt failing (149 errors) and cascaded to every consumer
(NavGraph "unresolved Phase", etc.). The source was ALWAYS correct.

FIX (app/build.gradle.kts):
  - implementation(platform("org.jetbrains.kotlin:kotlin-bom:2.0.0"))
  - implementation("org.jetbrains.kotlin:kotlin-reflect:2.0.0")
Both: BOM aligns all kotlin artifacts; explicit reflect pin guarantees it.

LESSON: when errors are "TypeX != TypeX" / module-wide unresolved on
verified-correct source, it's a DEPENDENCY/CLASSPATH version skew, not the
code. Run `:app:dependencies` and look for any kotlin artifact not matching
the compiler version. Should have checked this ~10 rounds earlier. The
breakthrough was getting real `./gradlew` terminal output instead of IDE
screenshots — the IDE only ever showed the cascade symptom.

NOTE: could not verify the fix in Claude's sandbox (services.gradle.org
blocked, no Android SDK). Fix is evidence-based but UNVERIFIED on build.
If reflect STILL shows 1.7.22 after this, the harder fix is excluding it
from jackson: implementation("...jackson-module-kotlin:2.17.2") { exclude
group: "org.jetbrains.kotlin", module: "kotlin-reflect" }

## v0.39.6 — FIX: duplicate aar fileTree broke the whole build (2026-06-05)

ROOT CAUSE of the 149-errors-in-VendingViewModel / "unresolved Phase"
saga: app/build.gradle.kts declared the Weimi .aar fileTree TWICE —
once added this session (mapOf syntax) at the top of dependencies{}, and
once pre-existing (lambda syntax) lower down. Duplicate = every com.weimi
class on the classpath twice → duplicate-class → whole module fails to
compile → every file cascades errors → Phase (in VendingViewModel.kt)
never produced → NavGraph import unresolved.

NOT iCloud, NOT folder-merge, NOT source logic — those were wrong guesses
that cost many rounds. Lesson: when a fresh clean extract of verified
source fails to compile module-wide, SUSPECT THE BUILD FILE
(dependencies, duplicates, plugins) before the environment. And after
adding any dependency, grep the block for duplicates.

Fix: removed the session-added duplicate, kept the pre-existing
`implementation(fileTree("libs") { include("*.aar","*.jar") })`. Now one
declaration. v0.39.6.

# Open Issues — Snarl & Sopi

Things known but deferred. Revisit before going live.

## Weimi "machine offline" status — RESOLVED (not a blocker)

When our app runs on a machine instead of the Weimi stock app, the Weimi
portal marks that machine as "offline." We previously called this a
deployment blocker. It is NOT.

**Investigation findings (2026-05-22):**

1. Catalog reads via `device-info` continue to work fine when the machine
   shows offline. Confirmed in production logcat — the app fetches 50
   aisles successfully from a machine Weimi reports as `isOnline: 0`.
2. Dispensing will work via the local Weimi serial SDK — no cloud
   dependency.
3. The third-party API has no heartbeat / online-status endpoint.
   `isOnline` is set by Weimi's cloud based on a connection their stock
   app maintains (probably MQTT). We cannot make our app appear "online"
   via documented API.
4. However: the third-party API has full write coverage for restocking
   via `POST /ext/aisle/goods/info/update` (deviceCode + full array of
   aisles with stock/price/goodsId). Admin backend can replicate the
   restock workflow entirely without using the Weimi portal.

**Decided 2026-05-22 (user)**: T&C compliance is not a concern. We will
not contact Weimi. Path forward:
- Admin backend (separate chat) implements restocking via the
  `aisle/goods/info/update` endpoint.
- Weimi portal becomes unused for AG Vending. Its "offline" flag is
  cosmetic in a UI we no longer use.

**Constraint to remember**: the restock endpoint requires submitting the
*full* machine state on any change — admin backend must keep a snapshot
of the current state and PUT the whole thing on every save.

## Hardware integration (not yet started)

- Wire Weimi serial SDK (`.aar` files from WmSdk2024) for dispense.
  Use `notifyShipment(aisleCodeList)` after successful payment — pick
  an available slot from `Product.slots` since we consolidated
  multi-slot products into one tile.
- Nayax serial integration (`/dev/ttyS3`, 9600 8N1, MDB bridge
  protocol). Payment instructions sent via `INSTRUCT_NAYAX_*` serial
  commands through the Weimi control board.
- Wire the existing PaymentScreen ("leggðu kort eða síma á posann") to
  the actual Nayax flow.

Best done with real hardware in front of us, not blind from emulator.

## Sub-operator name handling

Hardcoded as "AG Vending" in `VendingViewModel.loadCatalog`. Admin
backend (separate chat) will expose a deviceCode → display-name lookup
so each machine displays its sub-operator's configured name (e.g.
"Fylkir"). The Weimi third-party API does not expose sub-operator
binding even though their portal stores it.

## Machines 62160042 and 62160043

Non-standard layout. Currently blocklisted in `UNSUPPORTED_DEVICES`.
Once we understand what's different about them, decide whether to
support or permanently exclude.

## Admin features (not in this app)

User decided 2026-05-18 that admin (restock, slot reassignment, sales
history) belongs in the separate web backend being built elsewhere,
not embedded in this kiosk app. Don't add admin UI here.

## Admin backend integration

**API contract v0.1 drafted 2026-05-22** —
`/mnt/user-data/outputs/api-contract-v0.1.md`. Defines:
- Per-machine API key auth (provisioned at first run, sent as
  `X-Machine-Key` header)
- Single bundled `GET /api/v1/machines/{deviceCode}/config` returning
  profile + featured + ads
- Graceful degradation when backend is unreachable (cache → defaults)
- 15-minute sync cadence + on-demand refresh from diagnostics

**Addendum v0.3: WebSocket proxy** —
`/mnt/user-data/uploads/api-contract-addendum-proxy.md`. The kiosk
proxies Weimi API calls (`deviceProfile`, `deviceInfo`, `queryOrders`)
to the admin backend via a persistent WebSocket. This is a temporary
workaround for Weimi's WAF blocking the backend's Railway IP. To be
deleted once Weimi allow-lists the backend (or we move to a
residential/mobile proxy). See [Proxy bridge sunset path] below.

**v0.34 status — proxy bridge built (done in chat 2026-05-22)**:
- ✅ `proxy/BackendConfig.kt` — feature flag + URL + timing constants
- ✅ `proxy/ProxyState.kt` — connection state model
- ✅ `proxy/ProxyDispatcher.kt` — action allowlist (3 actions) + Weimi
     call forwarding + 25s timeout
- ✅ `proxy/ProxyClient.kt` — WebSocket lifecycle (connect, ping/pong,
     reconnect with backoff, halt-on-401)
- ✅ Diagnostics screen shows proxy status (tenging, beiðnir
     afgreiddar, smáatriði, endurtengja)
- ✅ Wired into ViewModel lifecycle (starts on Ready, stops on reset/
     factoryReset/onCleared)

**Open caveat — provisioning not yet built**: the proxy uses the
deviceCode as a placeholder for `machineKey` until the contract v0.1
provisioning flow (`POST /api/v1/machines/provision`) is implemented
on the kiosk side. Backend will likely reject with 401 until then —
proxy logs the failure, halts reconnects, and the kiosk keeps working
normally (no customer-facing impact).

### Proxy bridge sunset path

When Weimi allow-lists the backend (or alternative proxy is set up):
1. Set `BackendConfig.ENABLED = false` and ship a new kiosk build
2. Verify in production that no kiosks have active WebSocket connections
3. Verify nothing else in the codebase imports from `proxy/`
4. Delete the entire `proxy/` package + remove its imports from
   `VendingViewModel.kt` and `DiagnosticsScreen.kt`
5. Remove this section from OPEN-ISSUES

**Status**: contract v0.1 pending review in backend chat. Kiosk-side
implementation of v0.1 endpoints (provisioning + config fetch) deferred
until contract is reviewed and finalised.

## Cosmetic / polish

- **Product image normalization**: Weimi's image database has mixed
  backgrounds (some white, some transparent), inconsistent product
  sizing, varying aspect ratios. Long-term: normalize all images
  (transparent backgrounds, consistent sizing/centering) and serve
  from admin backend. Decided 2026-05-18: not a now-priority.
  Knock-on visual issue: hero tiles show whitespace gutters around
  products with white backgrounds — accept until images are
  normalized.
- **Colored product tiles** (deferred 2026-05-22, depends on image
  normalization above). Plan: each product tile gets a background
  color extracted from the product image, replacing the current
  category-based coloring. Intensity target is between mockup
  options A (soft) and B (medium) — clearly product-toned but
  harmonizing with cream. Implementation will be Palette extraction
  in the kiosk app + per-product manual override field in the admin
  backend for cases where the algorithm gets it wrong. Cannot ship
  until image backgrounds are transparent/consistent, otherwise
  Palette returns "white" for most products. Mockup at
  `/mnt/user-data/outputs/colored-tiles-mockup.html`.
- Real ad URLs from sponsors (currently Big Buck Bunny stub + 2 image
  ads with placeholder copy).
- Hero info/cart button spacing — possibly too close together for
  real fingers. Verify on real WM55 hardware before changing.
- Investigate `goodsExtendObject.had_hot_water` flag — kaffi machines?

## Deferred — depends on admin backend

- **Customer complaint flow** (mockup done 2026-05-23, build
  deferred). On the success screen:
  - **Auto-close timer extended to 20s** (was 8s) — customers need
    real time to fetch products from the flap and decide whether
    to complain
  - **New "corner advisory"** in soft bronze-tinted box: "vinsamlegast
    athugið að vörur geta fallið inn í hornin á afhendingarhólfinu"
  - **Quiet complaint entry** — small bronze ring "!" icon with
    "vantar vöru?" caption underneath (not a button with text)
  - Tapping the cluster cancels the auto-close timer and opens the
    complaint form

  Form captures: which items (checkboxes — supports multiple),
  optional free-text comment, customer's email for reply.

  Scope is specifically "items didn't vend." Customer can't
  reasonably know why a vend failed (spiral jam vs motor vs missed
  sensor); that's operator diagnostic work from the report.

  Mockup: `/mnt/user-data/outputs/complaint-flow-mockup.html`

  Implementation notes for later:
  - Use `imePadding()` on form root (lessons from setup screen
    keyboard issue)
  - Single-item transactions skip the checkbox UI (item pre-locked,
    label changes to singular "vara vantar")
  - Multi-item transactions show checkboxes — customer can flag
    multiple items in one complaint
  - Submit gated on ≥1 item selected AND email entered
  - GDPR notice near submit: "netfang aðeins notað til að svara þér"
  - API contract addition needed:
    `POST /api/v1/machines/{deviceCode}/complaints` with
    `{tradeNo, items: [{goodsId, name, priceIsk}, ...],
    note, customerEmail, timestampMs}`
  - Backend must commit to retention policy + actually reading these
  - Pattern detection on backend side: 3+ complaints about same
    aisle in 24h → push notification to operator

- **Error reporting / observability** (deferred 2026-05-22). Goal:
  errors from kiosks reach a central dashboard (AG Vending) for fleet
  debugging, and *network-class* errors trigger notifications to the
  relevant sub-operator (Fylkir, etc.) so they can physically check
  the venue's router. Decided to defer the entire reporting feature
  until the admin backend exists to receive reports — building the
  client side without a known backend contract risks shipping the
  wrong thing. Sentry/Bugsnag was considered as a stopgap but
  rejected for now. Error screen polish (v0.33) ships without
  reporting; auto-retry handles the user-visible side. Notes for
  later:
  - Local classification: connectionState=None / SocketTimeout /
    UnknownHost → network; HTTP 5xx → server; HTTP 4xx → config;
    empty product list → data
  - Network-class routes to location operator (needs operator contact
    info per deviceCode in admin backend)
  - Server/config/data routes to AG Vending only
  - Dedup + severity threshold + rate limiting on backend side
  - Local outbox in DataStore for persistence across reboots when we
    build the client side
- **Offline-capable sales** (deferred 2026-05-22 to hardware-adapter
  work). When the machine loses connection, continue selling from
  cached catalog; queue dispense + transaction records; sync to
  Weimi when connection returns via `notify-shipment` replay. Best
  built once hardware adapter + Nayax payment are wired so it can be
  designed against real dispense behavior. Requires careful handling
  of stock count drift, Nayax behavior (likely independent of our
  app since it has its own SIM), and time bounds (refuse sales after
  N hours offline to avoid stale prices).

## v0.30 status — diagnostics + lockdown (done in chat)

- ✅ Connectivity observer (Wi-Fi bars + cellular bars/gen + red fallback)
- ✅ Status bar connection indicator on every screen
- ✅ Immersive sticky lockdown (Android status/nav bars hidden)
- ✅ Long-press top-right clock → PIN entry (6 digits, hardcoded `123456`)
- ✅ Diagnostics screen with: tæki / staða / aðgerðir / óafturkræfar aðgerðir
- ✅ Actions: refresh catalog, intents to Wi-Fi/Android settings, show
     system bars, reset deviceCode (with confirm), factory reset (with confirm)

**TODO before deployment**:
- Swap hardcoded PIN for TOTP-from-backend in `DiagnosticsAuth.verify()`.
  Entry point is one constant + one comparison line — surgical change.
- Lockout after N wrong PIN attempts (currently unlimited retries).

## Deployment strategy (decided 2026-05-22)

**Launcher / boot behavior:**
- Uncomment the HOME intent filter in AndroidManifest before first
  real-hardware deployment (currently commented out for dev).
- On each WM55: use Weimi's "Other Setting → DesktopOption" to set our
  app as the launcher. Existing `BootReceiver` is the belt-and-suspenders
  fallback that explicitly launches MainActivity on `BOOT_COMPLETED`.
- Stock Weimi app stays installed (for cloud heartbeat) but is not the
  visible launcher.

**Status bar lockdown:**
- Weimi's system-level "Show StatusBar and Navigator" setting (in their
  Other Setting → System) is the real lockdown. Operator unchecks it
  once at deployment. Our app's immersive sticky is a secondary layer.

**Android Settings escape (v0.31.1):**
- When the diagnostics screen launches Android Settings via intent, it
  now also calls `onShowSystemBars` first so the Android nav bar is
  visible — otherwise the technician has no back button and gets stuck.
- TODO when testing on real hardware: confirm our app-level
  `showSystemBars` actually overrides Weimi's system-level hide setting.
  If it doesn't, the recovery path is reboot → BootReceiver →
  diagnostics → toggle Weimi's setting via "android stillingar" intent.

**Remote app updates — decided to use a real MDM (Scalefusion, Hexnode,
or similar) when we get to it.** Build deferred until first machines are
deployed and we have an MDM trial running. AG Vending operates ~60-70
machines remotely with sub-operators (Fylkir, etc.) doing daily ops, so
manual updates are not viable from day one. MDM also handles:
- Device-owner provisioning (we don't need to build this ourselves)
- Silent APK install (no user prompt)
- Remote monitoring + screenshots + reboot
- Fleet lockdown management
~$1.50-3 per device per month for commercial MDM; worth the cost at
fleet scale. We just need to keep our APK signing consistent.

## v0.39.5 status — hero-from-config wired + config poll defined (2026-06-05)

Backend chat sent a brief (kiosk-hero-brief.md): render `featured` from
`/config` in the hero zone instead of the hardcoded default. On
inspection, MOST of this was already built in a prior session:
- ConfigClient parses featured (goodsId/tag/order, sorted by order),
  profile, configVersion; handles 304.
- AdminBackendHttp.getJsonWithEtag does the If-None-Match round-trip.
- FeaturedProduct has `order`. defaultFeatured() is gone.
- Load flow calls fetchFeaturedFromConfig() and builds heroes from it;
  degrades to NO hero on failure (no fake default) per the brief.

BUT there was a latent COMPILE ERROR: the load flow called
`startConfigPoll(deviceCode)` (line 325) which was NEVER DEFINED. So the
project as-received would not have compiled. Fixed this build:
- Defined `startConfigPoll()` — the recurring 2-min config poll, which is
  ALSO the presence heartbeat. Re-resolves heroes against current catalog
  on a 200, keeps cache on 304/single-tick-failure, no backoff (protects
  backend's 2x presence threshold margin).
- Factored hero resolution into `resolveHeroes(featured, products)` —
  shared by initial load + poll. Skips goodsIds not in catalog / not
  visible. Empty → no hero (brief edge case).
- Added CONFIG_POLL_INTERVAL_MS = 2 min constant (coordinate with
  backend KIOSK_PRESENCE_THRESHOLD_MS if changed).

Authenticates today only for the test-key machine (Valhúsaskóli /
62160485 / Leiknir). Other machines get 401 → no hero (graceful).

### VERIFY at machine (Valhúsaskóli = test machine):
1. Set a featured product in operator portal for deviceCode 62160485.
2. Reload app (re-fetch config) → hero zone shows those products with
   tags in `order`. Or wait up to 2 min for the poll to pick it up live.
3. Debug payload check: GET
   https://snarl-sopi-production.up.railway.app/api/v1/debug/kiosk-config?deviceCode=62160485
4. Empty featured in portal → NO hero (not the old fake "nýtt").

### IMPORTANT fleet fact (corrected this session):
**ALL machines are chilled.** So the energy board (temp/power, SDK
section 3) is present FLEET-WIDE, not optional. The v0.39.4 energy probe
is testable on Valhúsaskóli (it's chilled). Temperature monitoring +
alerts apply to the whole fleet — this is core infra, not a
nice-to-have for some fridges. Re-scope the energy/climate backend
contract accordingly (it's fleet-wide telemetry, every machine reports).

### Valhúsaskóli = the test machine (was ambiguous before):
The physical unit at Valhúsaskóli IS deviceCode 62160485 (Leiknir) — the
test-key machine. So config auth, dispense (ttyS1, proven), and energy
probe all testable on this one unit. It is chilled.

## v0.39.4 status — energy/climate read-only probe + backend contract (2026-06-05)

Sigurður wants temperature read+configure, power-usage read, and LED
control, integrated with backend admin. All of this is the SDK's energy
board (section 3) — a SEPARATE board from the motor board, which may or
may not be fitted (chilled machines have it; ambient snack machines may
not). Sigurður has a chilled machine reachable to test.

Discipline: same as motor/Nayax — PROVE the hardware responds before
building the real feature. So this build is READ-ONLY probe + decoders;
control commands (set temp / LED / compressor) come AFTER the probe
confirms the board answers.

### SDK energy API (confirmed in bytecode + doc)
`MotorSerialPortKit.getEnergyInstruct()` →
- `ctlTemp(address, mode, temp)` — mode 0 read / 1 write. Reply
  (INSTRUCT_CTL_TEMP): cabinetTemp=data[20,24) signed÷10 °C,
  humidity=[24,28), evaporator=[28,32), status=[18,20).
- `getEleInfo(address)` — power. Reply (INSTRUCT_GET_ELE_INFO):
  energy=[18,26)÷100, voltage=[26,30)÷100 V, current=[30,34)÷100 A.
- `getAllDeviceStatus(address)` — overall energy hw status.
- `ctlLed(address, ledNum, isOpen)` — LED (ledNum 1=cab A, 2=cab B).
- `ctrlCompressor(address, mode, isOpen)`, `heatGlass(address, enable)`,
  `ledBrightnessAdjustment(address, pwm 1-10, ledNum)`.
- Compressor params (target temp 0x00, on/off 0x11, hysteresis 0x01,
  defrost max 0x06, defrost cycle 0x05) via param-address table.

### Built this session (v0.39.4) — READ-ONLY
- `HardwareController`: readTemperature / readPower / readEnergyStatus.
- `WeimiHardwareController`: implemented via getEnergyInstruct; receiver
  decodes INSTRUCT_CTL_TEMP / GET_ELE_INFO / GET_ALL_DEVICE_STATUS.
- `hardware/EnergyReading.kt`: parsers for temp + power frames. Validated
  in isolation incl. NEGATIVE temps (signed short, -10.0°C parses right).
  OFFSETS UNVERIFIED on hardware — from doc only.
- HardwareTestScreen: "orkubretti · lestur (kæling)" section — read
  temp / read power / read energy status buttons (read-only), italic
  warning it only works on a machine with the energy board.
- Backend contract drafted: api-contract-addendum-energy.md (telemetry
  up, climate config down via existing /config envelope, alerts design,
  per-machine useDropSensor flag lives here too).

### PROBE PLAN (Sigurður, on the CHILLED machine, today)
1. vélbúnaðarpróf → port: try `/dev/ttyS1` first (same as motor board —
   energy board MIGHT share it or be on another ttyS). baud 9600. opna port.
2. Tap "lesa hitastig" → watch event log for `← temperature: …  [raw=…]`.
   - If a decoded temp appears and looks sane (fridge ~2-6°C) → energy
     board works, offsets likely right.
   - If `→ readTemperature` with no `←` → board not on this port / not
     fitted. Try other ports (ttyS0/2/4), or this machine has no energy board.
3. Tap "lesa orkunotkun" → `← power: V=… A=…`. Sane mains ~230V?
4. Read me the RAW frames (via `adb logcat -s WeimiHardware`) so offsets
   can be confirmed/corrected before building control + backend.

### AFTER probe confirms (next build)
- Build control methods (set temp via ctlTemp mode=1, LED ctlLed,
  compressor ctrlCompressor) — only once reads are proven.
- Wire telemetry POST + climate config parse per the contract.
- Backend chat builds /telemetry endpoint + climate config + alerts.

## v0.39.3 status — DISPENSE PROVEN ON HARDWARE + result interpreter (2026-06-05)

### MILESTONE: the dispense path works end-to-end on a real WM55.
At Valhúsaskóli, on the real machine:
- **Motor control board is on `/dev/ttyS1`** @ 9600 baud (NOT ttyS3 —
  that's the Nayax). The board is a separate WM3.0DJ MCU board; the
  Android board talks to it over serial. Confirmed via the board pinout
  diagram (Z1/Z2 = motor matrix, Z3 = motor detect, 红外 = infrared,
  串口 = 485/TTL/232 serial block) + the silkscreen "TTYS3" label seen
  on the Android board (payment side).
- **Version read works**: `← cmd=68 data=FF010000000044000701010100000001FCD2`
  (cmd 68 = 0x44). Proves comms: header FF, addr 01, opcode, payload, CRC.
- **Dispense works**: tapped skammta hólf, **spiral 8 physically turned.**
  Ack frame: `← dispense ack data=FF01...28...00...` (opcode 0x28,
  shipmentResult byte 0x00 = success). One nibble dropped in the photo
  but structure + success code clear.
- **Infrared query returns nothing** (`→ queryInfrared(addr=0)`, no `←`).
  Because the drop sensor is DISABLED on this machine (see below).

### FLEET DECISION — CORRECTED: infrared is PER-MACHINE, not fleet-wide off.
Sigurður clarified: SOME operators have working infrared and want to KEEP
it. Others have it disabled (the small-item false-negative → slot-close
problem). So drop-sensor use must be a **per-machine option**, NOT a
fleet-wide hardcode.

DESIGN TODO (build once we have frames from an infrared-ACTIVE machine):
- Parser must PRESERVE the full truth from each frame: BOTH the
  motor-mechanical outcome AND the drop-detection signal, as separate
  facts. Do NOT collapse "motor worked, no drop" (0x11/0x12/0x20) to
  VENDED unconditionally — that discards info an infrared machine needs.
- A per-machine `useDropSensor` flag (eventually from backend config)
  decides how to COMBINE them into the final verdict:
  * infrared OFF → verdict = motor axis only; "no drop" ignored; never
    close slot on it (the bug-escape — what v0.39.3 does now).
  * infrared ON → verdict requires motor-completed AND drop-detected;
    "motor turned, nothing fell" becomes a real actionable failure.
- DO NOT lose any infrared data meanwhile. v0.39.3's DispenseResult
  keeps the raw resultCode (nothing lost yet), but its classify() maps
  no-drop codes to VENDED. Revisit once we capture infrared-active frames.
- CANNOT design/test the infrared-ON combine-logic until Sigurður is at
  a machine with active infrared (we've only seen infrared-OFF frames).
  Capture: clean success WITH drop, and "motor turned but no drop", via
  `adb logcat -s WeimiHardware`, then build dual-mode interpretation.

### FLEET DECISION (now scoped to SOME machines): infrared disabled where present-but-flaky.
Reason (sound): the infrared beam fails to detect SMALL items falling
through → board reads "no drop" → reports vend failure → **closes the
slot**. Result: successful vend recorded as fault, customer gets item
free, slot dead until serviced. The sensor's false-negatives cost more
than its value. Going forward all machines will have infrared disabled.

Consequence for design (BUILT into v0.39.3):
- Vend success is judged on the **motor-mechanical axis ONLY** (did the
  coil motor complete its rotation), drop detection IGNORED.
- **Never close a slot on a no-drop reading** (that's the bug being
  escaped). Codes 0x11/0x12/0x20 ("motor worked, no drop") → VENDED.
- The machine CANNOT confirm a product physically fell. Genuine
  deliver-failures (rare) are invisible to hardware, caught ONLY by the
  customer complaint flow = the agreed safety net. Refunds are
  trust-based (accepted).

### Built this session (v0.39.3)
- `hardware/DispenseResult.kt` — pure, unit-testable parser. Decodes the
  shipmentResult byte (doc offset [34,36)) → Outcome:
  VENDED / MOTOR_FAILED / ORDER_REJECTED / UNKNOWN. Motor-axis only;
  infrared-anomaly codes mapped to VENDED. Classification logic
  validated against the real success frame + documented codes.
- `WeimiHardwareController` receiver now decodes dispense acks via
  DispenseResult and surfaces it; `HardwareStatus.lastDispenseResult`
  added. Event log shows "← dispense: VENDED — motor ok …" not raw hex.

### v0.39.3 VERIFIED on hardware (infrared-off machine):
- Clean adb-logged success frame (slot 2 vended):
  `FF0100000000280009000000000000000000E0AA` (20 bytes: hdr FF, addr 01,
  opcode 28, then 09, payload zeros, CRC E0AA). Parser read [34,36)=00 →
  VENDED. Correct result, matched the physical vend.

### STILL TO VERIFY (needs a NON-ZERO result code, i.e. a real failure frame):
- The success frame is ALL ZEROS, so the parser landing on `00` at
  [34,36) gave the right answer but we can't be 100% sure it's reading
  the intended shipmentResult FIELD vs. coincidentally a zero byte before
  the CRC. Need a non-zero (failure) frame to confirm the offset points
  at the real result code. Infrared-OFF machines won't easily produce a
  failure (motor turns regardless), so capture on a slot/machine that can
  produce a genuine motor fault (dead/disconnected motor) or non-zero
  code. `adb logcat -s WeimiHardware`. Adjust DispenseResult offset if
  needed BEFORE money rides on it.
- Capture infrared-ACTIVE frames (success-with-drop + motor-turned-no-drop)
  on a machine that keeps infrared, to build the dual-mode interpretation.

### PAYMENT — still blocked, waiting on Weimi reply
Question sent to Weimi hardware chat: how does the stock app drive the
Nayax over ttyS3 (protocol or SDK params)? Their answer determines the
whole payment path. Recap of what's RULED OUT:
- Weimi SDK `getNayaxInstruct().sendPrice()` — TESTED on hardware,
  Nayax did NOT respond (sent `→`, no `←`, terminal stayed in V00
  fault). Either wrong transport or needs full host handshake.
- Nayax is a continuous-host serial link owned by stock `com.weimi` app
  on ttyS3. Kill the app → Nayax drops to "Cashless out of order V00".
  Restored by reboot.
- Stock app exposes `ISerialProxy` AIDL (sendData byte-transport) via
  `ExternalService`, but it's raw-bytes only — still needs the Nayax
  protocol, doesn't solve payment.
- DECISION: whole experience must go through Snarl & Sopi (no dual-app).
  That REQUIRES our app to drive payment → REQUIRES the Nayax RS232
  protocol. Only source now = Weimi (they integrated it). No Nayax
  contact; terminals came from Weimi with the machines.

### adb-over-WiFi notes (Valhúsaskóli, for next time)
- Pair: Settings→System→Developer→Wireless debugging→Pair with code.
  Pair PORT ≠ connect PORT. Connect port was 192.168.1.143:44777.
- After reboot it reconnects via mDNS name
  (adb-...._adb-tls-connect._tcp). With one device, drop `-s` entirely.
- To free ttyS3 for our app: `am force-stop com.weimi.monitor` then
  `am force-stop com.weimi` (watchdog first). HOME = com.android.launcher3
  (Quickstep) so stopping com.weimi does NOT strand the tablet. Reboot
  restores everything incl. the Nayax host link.

## v0.39.2 status — Nayax SDK bench test + Valhúsaskóli findings (2026-06-05)

### THE KEY FINDING: payment is Nayax RS232 on ttyS3, NOT MDB, NOT the
### Weimi SDK (as currently wired).

Captured a real payment logcat at Valhúsaskóli (machine has a working
Nayax, deviceCode 62160485 Leiknir, device name WM55L22) and inspected
the stock app's card-reader settings. Findings:

- Stock app is **imiVend** (`imivend.com`), NOT a Weimi SDK app. It runs
  its own cashless state machine (`vmc_vend_t`, `mdb_req_t`,
  `marshall_t`) and is the only process holding `/dev/ttyS3` open.
- Stock app's "Card reader setting" screen: type = **Nayax RS232**
  (selected), serial port = **ttyS3**, decimal place 0. MDB is a
  SEPARATE, unselected option. So the `mdb_*` log tags are the app's
  INTERNAL cashless-session naming; the actual wire transport is
  **Nayax's RS232 protocol**, not a physical MDB bus. (Sigurður caught
  this — Nayax is set to Level 3 and the stock app selects RS232.)
- Only ttyS3 is touched during payment (one `avc: denied getattr` on
  /dev/ttyS3 — SELinux-restricted, can't passively sniff while stock app
  holds it; `cat /dev/ttyS3` returned empty immediately = port already
  owned).

### SDK documentation gap (checked the PDF this session)
- The Weimi PDF (Unconfirmed_205744.pdf) DOES list the Nayax commands by
  name (`INSTRUCT_NAYAX_SEND_PRICE`, `_AGREE_PAY`, `_CANCEL`, etc.) under
  "MDB刷卡器相关的指令", and `NayaxInstruct` (sendPrice/cancelPrice/
  sendPriceEnd/...) exists in the SDK bytecode.
- BUT: dispense (`setShipments`) is FULLY documented (params + 30-row
  return-code table); Nayax payment has NO call signatures, NO param
  meanings, NO response codes. `getNayaxInstruct` appears 0 times in the
  doc. The doc repeatedly says "请咨询厂商" (consult manufacturer) for gaps.
- The SDK's Nayax commands imply Weimi's INTENDED topology = Nayax behind
  the control board. The machine is wired Nayax-direct-RS232 on ttyS3
  (stock app drives it). These may or may not be the same reachable
  reader — UNKNOWN until bench-tested.

### Payment architecture — STILL UNDECIDED (the central open question)
Three paths:
1. **Weimi SDK Nayax path** (undocumented but present) — try
   `getNayaxInstruct().sendPrice(...)` on the bench. If the Nayax wakes,
   payment becomes an SDK call like dispense. THIS BUILD adds the test.
2. **Build our own Nayax RS232 stack** — needs the Nayax RS232 protocol
   spec FROM NAYAX (Sigurður is a commissioned integrator). Days of work,
   money-correctness stakes. Only with a real spec, never logcat-guessed.
3. **Delegate to stock imiVend app** — needs imiVend to expose an
   integration surface (intent/service/API). UNKNOWN if it has one;
   supplier contact for imiVend is uncertain.

Recommendation: bench-test path 1 first (cheap, decisive), and in
parallel get the Nayax RS232 spec from Nayax. Do NOT hand-roll payment
on a guess.

### Built this session (v0.39.2)
- `HardwareController`: added EXPERIMENTAL `sendNayaxPriceRaw(address,
  slot, arg3, amount, orderId, arg6)` + `cancelNayaxPriceRaw(address,
  amount, orderId, arg4)`. Raw params because meanings are unconfirmed.
- `WeimiHardwareController`: implemented via
  `MotorSerialPortKit.getNayaxInstruct()?.sendPrice(...)` / `.cancelPrice(...)`.
  Signatures match bytecode descriptors `(IIIJLjava/lang/String;I)V` and
  `(IJLjava/lang/String;I)V` — so should COMPILE; whether the
  param order/meaning is right is what the bench test determines.
- `HardwareTestScreen`: new "tilraun · nayax gegnum sdk" section with
  editable raw fields (arg3/amount/orderId/arg6) + sendPrice/cancel
  buttons. Italic warning to test with low amount + stock app closed.
- Receiver already labels Nayax response codes (AGREE_PAY/REFUSED/etc.)
  for live observation.

### Bench-test plan (next session at the machine)
1. CLOSE the stock imiVend app first (frees ttyS3). Critical — only one
   process can own the port.
2. vélbúnaðarpróf → set port `/dev/ttyS3`, baud 9600 → opna port.
3. Nayax section: amount=100 (or small), orderId=TEST0001, arg3=0,
   arg6=0 → "senda verð á posa".
4. WATCH THE NAYAX TERMINAL. If it wakes / asks for a card → SDK path
   (path 1) is viable, refine params from there. If nothing → readers
   are on the direct-RS232 path the stock app uses, SDK path won't drive
   them, fall back to path 2 or 3.
5. Dispense test is SEPARATE: the control board is on a DIFFERENT ttyS
   (the SDK demo opens ttyS3 AND ttyS1). For dispense, try the other
   port. Steps: read version → dispense slot → drop sensor.

### NOT done / NOT verified
- v0.39.2 NOT compile-checked by me (self-checked imports + signatures
  against bytecode; should be clean but verify on sync).
- Nayax param meanings UNCONFIRMED — the whole point of the bench test.
- adb-over-WiFi working at Valhúsaskóli: paired+connected to
  192.168.1.143:44777 (connect port; pair port was different). Device
  shows twice (IP + mDNS) so must use `-s 192.168.1.143:44777` on every
  adb command.

## v0.39 status — Weimi SDK linked + hardware test screen (done in chat 2026-06-05)

Prep for hardware testing. The three Weimi SDK .aar files are now
linked and a debug-only hardware test screen drives the dispense side.
No payment code yet — Nayax topology must be confirmed first (Step 0).

**SDK findings (from inspecting the .aars + demo):**
- 3 libs: base-sdk (serial transport, com.weimi.serialport.*),
  motor-sdk (instructs, com.weimi.motorserial.*), annuo-sdk (board
  variant, likely unused on standard WM55).
- Dispense: `MotorInstruct.setShipments(address, slot, 0L)`.
- Drop sensor: `MotorInstruct.queryInfrared(address)` — distinguishes
  successful vs failed vend, feeds the complaint flow.
- Comms proof: `MotorInstruct.getVersion(address)`.
- Init: `MotorSerialPortKit.initSerialPortKit()` then
  `startSerialPortKit(ctx, startCb, configArray, rxCb)` with
  `SerialportConfigBean(portPath, baud, 0, 0)`.
- **The full Nayax command set exists in motor-sdk**
  (`MotorInstructCode.INSTRUCT_NAYAX_*`: SEND_PRICE, SEND_PRICE_END,
  CANCEL, AGREE_PAY, REFUSED, READ_CARD, OUT_GOOD_RESULT, etc.) and
  `MotorSerialPortKit.getNayaxInstruct()` exists. This strongly implies
  Weimi's *intended* topology is "Nayax behind the control board." That
  CONFLICTS with the user's description (Nayax on /dev/ttyS3 → Android →
  control board). **Step 0 of hardware testing resolves which is real**
  before any payment code is written.
- The demo's CardMdbFragment + PaperCoinFragment are EMPTY stubs — no
  worked payment example ships in the demo.

**Built this session:**
- ✅ 3 .aar files in `app/libs/`, linked via fileTree in build.gradle.kts
- ✅ `hardware/HardwareController` interface — dispense methods only;
     payment deliberately absent until topology confirmed
- ✅ `hardware/WeimiHardwareController` — wraps MotorSerialPortKit;
     every SDK reply surfaced into `status.lastEvent`; Nayax response
     codes labelled in the receiver for live observation (read-only,
     commits to nothing)
- ✅ `ui/screens/hardware/HardwareTestScreen` — debug-only, gated by
     BuildConfig.DEBUG at the call site. Port/baud config, the safe
     sequence (read version → channel status → dispense → drop sensor),
     live event log. No payment buttons.
- ✅ Diagnostics gains a "vélbúnaðarpróf" entry (debug builds only)
- ✅ Route `admin/hardware-test`

**NOT done (deliberately):**
- No payment calls (Step 0 first)
- Hardware controller not wired into the real payment/success flow —
  it's standalone behind the debug screen until the safe sequence is
  proven at the machine
- SDK manifest merges in a `MotorSerialPortService` (separate process)
  automatically — no action needed, just noted

**Tomorrow's session:** see hardware-testing-prep.md. Step 0 (observe
the stock app taking a real payment + which serial port lights up)
before anything else.

## v0.38 status — test machine key injection (done in chat 2026-06-02)

Real-hardware testing of v0.37 confirmed every backend-touching feature
was blocked on auth (401). Per agreement with backend chat, they minted
a one-off test machineKey for deviceCode `62160485` (Leiknir). The
kiosk needs to send that key without it ever entering the repo.

Approach:
- ✅ `local.properties` keys `TEST_MACHINE_KEY` and
     `TEST_MACHINE_DEVICE_CODE` (both gitignored)
- ✅ `app/build.gradle.kts` reads them at configure time and surfaces
     them as `BuildConfig.TEST_MACHINE_KEY` /
     `BuildConfig.TEST_MACHINE_DEVICE_CODE`
- ✅ New `resolveMachineKey(deviceCode)` in `VendingViewModel` returns
     the test key only when (test key non-blank) AND
     (test-device-code matches running deviceCode). Otherwise falls
     back to placeholder (deviceCode) — same behaviour as v0.37 for
     non-test machines.
- ✅ Added root `.gitignore` (was missing) covering `local.properties`,
     `build/`, `.idea/`, etc.

**Constraints accepted with backend chat:**
1. Side-load only — never publish a build with this configuration
2. Key lives in local.properties only — never in git
3. Delete this whole arrangement once provisioning ships; backend
   will revoke the test key server-side at the same time

**To delete later** (single PR after provisioning lands):
- Remove the `localProps` block + `buildConfigField` lines from
  `app/build.gradle.kts`
- Remove `resolveMachineKey()` from `VendingViewModel.kt`; restore
  the placeholder line
- Have the user remove `TEST_MACHINE_KEY` from their local.properties

## v0.37 status — setup keyboard fix (done in chat 2026-06-02)

Real-hardware bug from first WM55 session: when entering deviceCode
on setup screen, Android soft keyboard covers the bottom half of the
screen including the "áfram" button. Pressing Enter on the keyboard
didn't submit either.

Fix:
- ✅ `imePadding()` on root Column — layout shifts up when keyboard
     appears, buttons stay reachable
- ✅ `KeyboardOptions(imeAction = ImeAction.Done)` on the text field —
     keyboard shows a "done" indicator
- ✅ `KeyboardActions(onDone = { runCheck() })` — tapping the done
     key submits, same as tapping the button

InputBlock gained a new `onSubmit: () -> Unit = {}` parameter, passed
through from all four phase branches.

## v0.36 status — customer complaint flow (done in chat 2026-05-23)

Built end-to-end against backend's v4.1 (v0.4 contract accepted):

**Data layer:**
- ✅ `data/backend/AdminBackendHttp.kt` — HTTP client with
     `X-Machine-Key` header, categorized failures (network / server /
     unauthorized / client / unknown)
- ✅ `data/backend/ComplaintClient.kt` — typed `submit()` returning
     complaintId
- ✅ `data/backend/ComplaintRepository.kt` — submit-or-queue +
     opportunistic `flushQueue()`
- ✅ `data/backend/ComplaintQueueStore.kt` — DataStore-backed FIFO
     queue with 50-cap and 24h TTL

**ViewModel:**
- ✅ `completePayment()` captures the basket as a `CompletedTransaction`
     with a generated tradeNo, then clears the basket
- ✅ `submitComplaint(items, note, email)` builds the payload and
     submits via repository
- ✅ Lazy repo construction in `ensureProxyStarted` so it gets both
     a deviceCode and (eventually) a real machineKey
- ✅ Opportunistic queue flush on startup
- ✅ New state fields: `lastCompletedTransaction`,
     `complaintSubmission`, `complaintQueueSize`

**UI:**
- ✅ `SuccessScreen` rewrite — keeps the 200sp "takk." hero,
     adds soft bronze-tinted corner advisory and quiet "vantar
     vöru?" entry button. Timer extended from 8s → 20s.
- ✅ `ComplaintFormScreen` — checkbox items (multi-select),
     optional note (≤280 chars), required email with format check,
     submit gated until valid. `imePadding()` for keyboard handling.
- ✅ `ComplaintConfirmationScreen` — bronze ring + "kvörtun
     móttekin." + 6s auto-close. Same display for accepted-now
     and queued-for-later (customer doesn't need to know).

**Includes the two extra fields backend asked for:**
- `kioskAppVersion` from BuildConfig.VERSION_NAME
- `kioskOsLocale` from Locale.getDefault().toString()

**Caveats:**
- Provisioning isn't built — placeholder uses deviceCode as
  machineKey. Backend will reject with 401; ComplaintRepository
  surfaces this as `Failed("auth")`; for now the kiosk doesn't
  re-provision (would need the contract v0.1 `/provision` endpoint
  built). When provisioning ships, replace placeholderKey in
  `ensureProxyStarted`.
- Dispense-slot pills removed from success screen — they would
  give false confidence once real dispense is wired (some slots
  may fail to dispense).



- ✅ Variant B: "instruction-first" payment screen
- ✅ Hero instruction "leggðu kort eða síma á posann" elevated to
     ~64sp italic — now the visual focus
- ✅ 240sp total price removed — no more screaming the price
- ✅ Receipt block moved to bottom: items with muted per-line
     prices, divider, total in modest typography
- ✅ Arrow points right → toward physical Nayax terminal location
     on WM55 cabinet
- ✅ Customer transparency preserved (all prices still visible)

Behavioral rationale: vending markups can feel high; leading with
a giant price gave customers a sticker-shock moment at the exact
point they should be executing. Variant B treats the sale as a
routine action ("do this") rather than an open decision ("how
about this price?"). Mockup at
`/mnt/user-data/outputs/payment-redesign-mockup.html`.

## v0.33 status — error screen polish (done in chat)

- ✅ Two-tier error screen: customer view (calm, no buttons) +
     operator view (technical, reached via long-press → PIN)
- ✅ Auto-retry with exponential backoff (5s, 15s, 30s, 60s capped)
- ✅ Live countdown ("að reyna aftur í Ns") with subtle pulsing dots
- ✅ Connection indicator shown on error screen too (same status bar)
- ✅ Successful retry → automatic transition to Ready
- ✅ Operator-view "reyna núna" button interrupts the timer for
     immediate retry
- ✅ Removed "frá Weimi" wording (replaced with "frá vefþjónustu")
     where it can bubble into user-facing display
- ✅ Debug-only "force test error" button in diagnostics
     (BuildConfig.DEBUG only, gated out of release builds)

**TODO on real WM55 hardware** (emulator network sim is unreliable):
- Verify error screen actually shows when Wi-Fi truly drops
- Verify auto-retry backoff fires correctly through 5s/15s/30s/60s
- Verify connection observer flips to `None` when Wi-Fi disabled
- Verify operator-view PIN flow + "reyna núna" button works under
  real network failure
The Android emulator routes traffic through the host even with
its "Wi-Fi off" toggle, so the app appears to recover even when
the in-app indicator shows no connection. This is not a bug in
our code; it's an emulator limitation.

## v0.32 status — setup screen polish (done in chat)

- ✅ Status bar on setup (connection indicator + clock + brand)
- ✅ Pre-commit verification: connection check + deviceProfile lookup
- ✅ Confirmation card showing deviceName before saving deviceCode
- ✅ Three differentiated error states: no internet / code not found /
     server error — each with its own copy and retry path
- ✅ Loading state with spinner during the check (~1-2s)
- ✅ Removed all front-facing "Weimi" mentions; replaced with
     "vefþjónusta" in user copy. Code-internal class names unchanged.
