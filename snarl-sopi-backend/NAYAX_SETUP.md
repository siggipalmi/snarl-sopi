# Nayax API Setup

The backend can pull real-time machine status, names, and recent sales from Nayax's Lynx API. Once configured, linked machines auto-sync every 60 seconds — so the dashboard shows accurate online/offline status without depending on Weimi or the kiosk app.

This is independent of Weimi. You can have both running, or just Nayax, or just Weimi (via kiosk proxy).

## Step 1 — Generate an API token in Nayax Core

1. Log in to [Nayax Core](https://core.nayax.com)
2. Click your username (top right) → **Account Settings**
3. Open the **Security & Login** tab
4. Scroll to **User Tokens**
5. Click **Show Token** next to an existing token, or create a new one
6. Copy the token (treat it like a password — anyone with it can read your data)

## Step 2 — Add the token to Railway

1. Open your Railway project → click your service → **Variables** tab
2. Click **+ New Variable** and add:

| Name | Value |
|---|---|
| `NAYAX_TOKEN` | the token from Step 1 |
| `NAYAX_ENV` | `prod` (default), or `qa` if you want the staging environment |

3. Railway will redeploy automatically (~1-2 min)

## Step 3 — Verify the connection

Open the dashboard → **Settings** → scroll down to the **"nayax integration"** panel. After redeploy you should see:

- **connection: connected**
- **environment: prod**
- **linked machines: 0** (until you link some — next step)

If you see an error here, check the Railway logs for `[NAYAX]` lines.

## Step 4 — Link your machines

1. Go to the **Machines** page
2. In the **nayax** column, click **"link →"** next to a machine
3. Enter the Nayax MachineID — you can find this in Nayax Core:
   - **Operations → Machines** → click on a machine → **General Information** tab → look for "MachineID"
4. Click OK
5. The machine immediately syncs — its status updates and the linked Nayax MachineID shows in the column

Repeat for each machine. The mapping is one-time.

## Step 5 — Verify auto-sync

Once at least one machine is linked, the backend auto-syncs every 60 seconds. To force a sync of all linked machines at once:

- **Settings → Nayax panel → "sync all →"** button

In Railway → Deploy Logs you'll see:
```
[NAYAX] Auto-sync enabled (60s interval)
[NAYAX] auto-sync: 5 ok, 0 fail
```

## Troubleshooting

**"NAYAX_TOKEN not set"**
The env variable isn't picked up. Check spelling exactly (`NAYAX_TOKEN`, all caps, underscore). Railway shows current vars in the **Variables** tab.

**"NAYAX_AUTH (401)"**
Token is invalid or expired. Generate a fresh one in Nayax Core and update Railway.

**"NAYAX_RATE_LIMITED (429)"**
Too many requests. Auto-sync runs every 60s for all linked machines — for 33 machines that's still well under any reasonable rate limit. If this happens often, lower the sync frequency in `src/server.js` (`INTERVAL_MS`).

**Machine shows as linked but status doesn't update**
Click "sync all →" to force a fresh sync. Check `[NAYAX]` log lines for errors. The Nayax MachineID may be wrong — verify it in Nayax Core.

## What gets fetched

For each linked machine, the backend stores:
- **isOnline** / **isRunning** — derived from Nayax's `Status` or `IsOnline` field
- **nayaxData.rawStatus** — the raw status string from Nayax (for debugging)
- **nayaxData.nayaxName** — the machine name in Nayax's system (you keep your local name)
- **nayaxData.lastActivity** — when Nayax last heard from the machine
- **nayaxData.full** — the full Nayax response JSON, for future use

This is in addition to sales data, which the kiosk app reports separately via `POST /api/v1/machines/:deviceCode/sales`.

## Per-machine endpoints

- `POST /api/v1/machines/:deviceCode/nayax/link` — set/unset the Nayax MachineID
- `POST /api/v1/machines/:deviceCode/nayax/sync` — sync one machine immediately
- `GET /api/v1/machines/:deviceCode/nayax/sales` — recent sales for one machine

These are scoped — operators can only sync/view their own machines. AG admins can do anything.

## Future possibilities

- Pull Nayax sales as an alternative/supplement to kiosk-reported sales (more reliable for the 9 non-kiosk machines)
- Cross-check kiosk-reported sales against Nayax's records (detect missing/extra entries)
- Pull inventory data if Nayax has it
- Use the device serial number on each card reader to auto-link without manual entry (need to add a serial field to our machines table)
