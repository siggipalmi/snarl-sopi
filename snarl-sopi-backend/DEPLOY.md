# Deploy to Railway

## Step 1 — Push to GitHub

1. Go to https://github.com/new
2. Repository name: `snarl-sopi-backend`
3. Set **Private** (it has Weimi credentials)
4. Click **Create repository**
5. On the next page, click **"uploading an existing file"** link
6. Drag the contents of this folder (not the folder itself) into the upload area
7. Commit message: `initial commit`
8. Click **Commit changes**

## Step 2 — Deploy on Railway

1. Go to https://railway.app and sign in with GitHub
2. Click **New Project** → **Deploy from GitHub repo**
3. Authorize Railway to access your repos if prompted
4. Select `snarl-sopi-backend`
5. Railway auto-detects Node.js and starts deploying
6. Wait ~2 minutes for the build to complete

## Step 3 — Get your public URL

1. In the Railway dashboard, click on your service
2. Go to the **Settings** tab → **Networking**
3. Click **Generate Domain**
4. You'll get a URL like `https://snarl-sopi-backend-production.up.railway.app`

## Step 4 — Configure environment variables (optional but recommended)

In Railway → Settings → Variables, add:
- `WEIMI_APP_ID` — your Weimi app ID
- `WEIMI_SECRET_KEY` — your Weimi secret key
- `WEIMI_ENV` — `prod`
- `JWT_SECRET` — any long random string for signing tokens
- `KIOSK_SECRET` — legacy, can leave default

These override the values in src/db.js so you don't have to hardcode them.

## Step 5 — Visit your dashboard

Open your Railway URL in a browser. The login page appears.
Sign in with sky@agvending.is / demo.

## Step 6 — Contact Weimi

Send Weimi the IP address Railway's server uses (visible in their docs).
Ask them to whitelist it so the backend can call their API.
