# Railway Volume Setup (Required for Persistent Storage)

The backend uses SQLite to persist data — users, machines, sales, alerts,
invitations — to a file. **Without a Railway Volume, that file gets wiped
on every redeploy.**

This guide walks through adding a persistent volume.

## Step 1 — Add a Volume to your Railway service

1. Open your Railway project → click on your service
2. In the **Settings** tab, scroll down to **Volumes**
3. Click **Add Volume**
4. Configure:
   - **Mount Path**: `/data`
   - **Size**: 1 GB is plenty (you can resize later)
5. Click **Add Volume**
6. Railway will redeploy automatically to mount the volume

## Step 2 — Verify the volume mounted

In Railway → Deployments → Deploy Logs, you should see this on startup:

```
[STORAGE] Database: /data/snarl-sopi.db
[STORAGE] Schema ready
[DB] Empty database — seeding initial data...
[DB] Seeded 16 operators, 33 machines, 3 users
```

The first time you deploy with the volume, the database is empty so it
gets seeded with the default operators/machines/users. After that, the
file persists.

If you ever see `[STORAGE] /data not writable, falling back to /tmp`,
the volume isn't mounted — go back to step 1.

## Step 3 — Sanity check after the first invite

1. Sign in as Sky, invite a new user
2. Accept the invitation, set their password
3. Watch the Railway deploy logs for `[DB]` lines
4. Trigger a redeploy (push any change to GitHub) and watch logs again
5. Sign in as the user you invited — they should still exist

If they're gone, the volume isn't doing its job.

## How big is "big enough"?

For this app's scale (33 machines, dozens of users, thousands of sales/day),
1 GB will last several years. Sales records are tiny — typically <1 KB each.

If you ever want to download the database for backup:

1. Railway → service → **Volumes** tab
2. There's no UI for download yet, but you can use the Railway CLI:
   ```
   railway run cat /data/snarl-sopi.db > backup.db
   ```
3. Or add a backup endpoint to the backend (we can do this later)

## What's stored where now?

| Data | Location |
|---|---|
| Operators, machines, users | SQLite (persistent) |
| Sales orders, alerts, invitations | SQLite (persistent) |
| Machine API keys | SQLite (persistent) |
| Session tokens (after login) | In-memory (fine to lose on restart) |
| WebSocket connection state | In-memory (kiosks reconnect after restart) |
