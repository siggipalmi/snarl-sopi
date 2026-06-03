# SendGrid Email Setup

The backend uses SendGrid to send invitation emails to new users. If SendGrid
is not configured, invitation emails will still be **logged to the Railway
console** so you can manually copy the link and send it however you like
during development.

For production, follow the steps below.

## Step 1 — Create a SendGrid account

1. Go to [sendgrid.com](https://sendgrid.com) and sign up (free)
2. Enable two-factor authentication when prompted (required)
3. Free tier: 100 emails per day (forever, no card needed)

## Step 2 — Verify your sender identity

This is the step most people skip — without it, every email gets a 403.

**Option A (quick): Single Sender Verification**

1. In SendGrid dashboard, go to **Settings → Sender Authentication**
2. Click **Verify a Single Sender**
3. Enter the email you want to send from (e.g. `hallo@snarlogsopi.is`)
4. Fill in the form (name, address — for the email footer)
5. Check that inbox and click the verification link

This works immediately. Good for testing.

**Option B (proper): Domain Authentication**

1. **Settings → Sender Authentication → Authenticate Your Domain**
2. Choose your DNS provider, enter `snarlogsopi.is`
3. Add the 3 CNAME records SendGrid shows you to your DNS
4. Wait 5-30 minutes, click **Verify**

Domain auth means emails won't go to spam. Do this before going live.

## Step 3 — Create an API key

1. **Settings → API Keys → Create API Key**
2. Name it `snarl-sopi-backend`
3. Permissions: **Restricted Access → Mail Send → Full Access**
4. Click **Create & View**
5. **Copy the key immediately** — SendGrid won't show it again

## Step 4 — Add the key to Railway

1. Go to your Railway project → service → **Variables**
2. Add these:

| Name | Value |
|---|---|
| `SENDGRID_API_KEY` | the key from step 3 |
| `EMAIL_FROM` | the verified sender (e.g. `hallo@snarlogsopi.is`) |
| `EMAIL_FROM_NAME` | `Snarl & Sopi` |
| `APP_URL` | `https://snarl-sopi-production.up.railway.app` |

3. Railway redeploys automatically.

## Step 5 — Test

1. Sign in to the dashboard as Sky
2. Go to **Users** → **+ invite user**
3. Invite yourself or a colleague
4. Check inbox — invitation email should arrive within ~30 seconds

If something fails, check Railway → Deployments → Logs for `[EMAIL] failed`
messages.

## Reading the dev-mode logs

If `SENDGRID_API_KEY` is not set, invitation emails are printed to the
Railway logs instead of being sent. The link will look like:

```
──── [EMAIL DEV MODE] ────────────────────────
To:      anna@fylkir.is
Subject: Sky K. hefur boðið þér aðgang að Snarl & Sopi
...
https://snarl-sopi-production.up.railway.app/?invite=inv_a1b2c3...
──────────────────────────────────────────────
```

You can copy the link manually and send it via Slack/SMS/etc until SendGrid
is set up.
