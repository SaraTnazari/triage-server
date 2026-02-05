# Deployment Guide for Communication Triage Server

This guide walks you through deploying your automation server to the cloud so Gmail push notifications and Slack webhooks work 24/7.

---

## Option 1: Railway (Recommended - Free Tier)

Railway is the easiest option with a generous free tier.

### Step 1: Create Railway Account
1. Go to [railway.app](https://railway.app)
2. Sign up with GitHub

### Step 2: Deploy from GitHub
1. Push your `radar-app` folder to a GitHub repo
2. In Railway, click **New Project** → **Deploy from GitHub repo**
3. Select your repo

### Step 3: Add Environment Variables
In Railway dashboard → your project → **Variables** tab, add:

```
PORT=3000
SUPABASE_URL=https://bmfmzirwdzuvwrnroofv.supabase.co
SUPABASE_ANON_KEY=your-key
GMAIL_CLIENT_ID=your-client-id
GMAIL_CLIENT_SECRET=your-client-secret
GMAIL_REFRESH_TOKEN=your-refresh-token
GMAIL_PUBSUB_TOPIC=projects/your-project/topics/gmail-notifications
SLACK_SIGNING_SECRET=your-signing-secret
SLACK_BOT_TOKEN=xoxb-your-token
```

### Step 4: Get Your Public URL
Railway gives you a URL like: `https://your-app.up.railway.app`

Use this URL for:
- Gmail Pub/Sub push subscription: `https://your-app.up.railway.app/gmail/webhook`
- Slack Events URL: `https://your-app.up.railway.app/slack/webhook`
- Google OAuth redirect: `https://your-app.up.railway.app/auth/google/callback`

---

## Option 2: Render (Free Tier)

### Step 1: Create Render Account
1. Go to [render.com](https://render.com)
2. Sign up with GitHub

### Step 2: Create Web Service
1. Click **New** → **Web Service**
2. Connect your GitHub repo
3. Settings:
   - **Name**: communication-triage
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`

### Step 3: Add Environment Variables
Same as Railway (see above)

### Step 4: Deploy
Click **Create Web Service** and wait for deployment

---

## Option 3: Fly.io (Free Tier)

### Step 1: Install Fly CLI
```bash
# macOS
brew install flyctl

# Windows
powershell -Command "iwr https://fly.io/install.ps1 -useb | iex"
```

### Step 2: Login & Deploy
```bash
cd radar-app
fly auth login
fly launch
```

### Step 3: Set Environment Variables
```bash
fly secrets set SUPABASE_URL=https://bmfmzirwdzuvwrnroofv.supabase.co
fly secrets set SUPABASE_ANON_KEY=your-key
fly secrets set GMAIL_CLIENT_ID=your-client-id
# ... add all other variables
```

---

## After Deployment: Update Webhook URLs

### 1. Update Google OAuth Redirect URI
Go to [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials → Your OAuth Client

Add your production URL:
```
https://your-app.up.railway.app/auth/google/callback
```

### 2. Update Gmail Pub/Sub Subscription
In Google Cloud Console → Pub/Sub → Subscriptions → Your subscription

Update push endpoint to:
```
https://your-app.up.railway.app/gmail/webhook
```

### 3. Update Slack Event Subscriptions
In [Slack API](https://api.slack.com/apps) → Your App → Event Subscriptions

Update Request URL to:
```
https://your-app.up.railway.app/slack/webhook
```

### 4. Re-authenticate Gmail
Visit your deployed app's auth URL:
```
https://your-app.up.railway.app/auth/google
```

Then activate the watch:
```bash
curl -X POST https://your-app.up.railway.app/gmail/watch
```

---

## Verify Everything Works

### Health Check
```bash
curl https://your-app.up.railway.app/health
```

Expected response:
```json
{
  "status": "ok",
  "gmail": true,
  "slack": true
}
```

### Test Gmail Sync
```bash
curl -X POST https://your-app.up.railway.app/gmail/sync
```

### Check Pending Actions
```bash
curl https://your-app.up.railway.app/pending
```

---

## Troubleshooting

### Server crashes on startup
- Check all environment variables are set
- Verify Supabase URL and key are correct

### Gmail push not working
- Ensure Pub/Sub topic has correct permissions
- Re-run `POST /gmail/watch` after deployment

### Slack events not received
- Verify signing secret matches
- Check Slack app has `message.im` event subscribed
- Ensure bot is installed to workspace

### SSL/HTTPS errors
- All cloud platforms provide HTTPS automatically
- Make sure you're using `https://` URLs everywhere
