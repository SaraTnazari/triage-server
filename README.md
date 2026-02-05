# Communication Triage Automation Server

Automatically capture incoming emails and Slack DMs, saving them to your Supabase pending_actions table for triage.

## Features

- **Gmail Integration**: Real-time email notifications via Gmail API + Pub/Sub
- **Slack Integration**: Webhook receiver for direct messages
- **Duplicate Protection**: Won't add the same message twice
- **Magic Links**: Direct links to open emails/messages with one click

---

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your credentials (see setup below)

# Start the server
npm start
```

---

## Setup Guide

### 1. Supabase Database

Run the migration in your Supabase SQL Editor:

```bash
# Copy contents of supabase-migration.sql and run in Supabase
```

This adds the required columns: `platform`, `message_id`, `sender`, `summary`, `url`

### 2. Gmail Setup

#### A. Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (or use existing)
3. Enable the **Gmail API**
4. Go to **Credentials** > **Create Credentials** > **OAuth Client ID**
5. Choose **Web application**
6. Add authorized redirect URI: `http://localhost:3000/auth/google/callback`
7. Copy **Client ID** and **Client Secret** to your `.env`

#### B. Connect Your Gmail

1. Start the server: `npm start`
2. Visit: `http://localhost:3000/auth/google`
3. Sign in with your Google account
4. Copy the refresh token shown and add to `.env`
5. Restart the server

#### C. Enable Push Notifications (Optional)

For real-time email alerts:

1. In Google Cloud Console, go to **Pub/Sub**
2. Create a topic: `gmail-notifications`
3. Grant `gmail-api-push@system.gserviceaccount.com` **Pub/Sub Publisher** role
4. Create a **Push subscription** pointing to your server:
   - Endpoint: `https://your-server.com/gmail/webhook`
5. Add topic name to `.env`: `GMAIL_PUBSUB_TOPIC=projects/your-project/topics/gmail-notifications`
6. Call `POST /gmail/watch` to activate

**Note**: For push notifications, your server must be publicly accessible (use ngrok for local testing).

### 3. Slack Setup

#### A. Create Slack App

1. Go to [Slack API Apps](https://api.slack.com/apps)
2. Click **Create New App** > **From scratch**
3. Name it (e.g., "Triage Bot") and select your workspace

#### B. Configure Permissions

1. Go to **OAuth & Permissions**
2. Add these **Bot Token Scopes**:
   - `users:read` - Get sender names
   - `im:history` - Read DM history
   - `im:read` - Access DM conversations
3. Click **Install to Workspace**
4. Copy the **Bot User OAuth Token** to `.env`

#### C. Set Up Event Subscriptions

1. Go to **Event Subscriptions**
2. Enable Events: **On**
3. Request URL: `https://your-server.com/slack/webhook`
   - Slack will verify the endpoint
4. Subscribe to bot event: `message.im`
5. Save Changes

#### D. Get Signing Secret

1. Go to **Basic Information**
2. Copy **Signing Secret** to `.env`

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/auth/google` | Start Gmail OAuth flow |
| GET | `/auth/google/callback` | OAuth callback handler |
| POST | `/gmail/watch` | Enable Gmail push notifications |
| POST | `/gmail/webhook` | Receive Gmail push events |
| POST | `/gmail/sync` | Manually sync recent emails |
| POST | `/slack/webhook` | Receive Slack events |
| GET | `/health` | Health check |
| GET | `/pending` | List all pending actions |
| DELETE | `/pending/:id` | Delete a pending action |

---

## Testing

### Manual Gmail Sync

```bash
curl -X POST http://localhost:3000/gmail/sync \
  -H "Content-Type: application/json" \
  -d '{"maxResults": 5}'
```

### Health Check

```bash
curl http://localhost:3000/health
```

### List Pending Actions

```bash
curl http://localhost:3000/pending
```

---

## Deployment

For production, deploy to a platform like:

- **Railway** - `railway up`
- **Render** - Connect GitHub repo
- **Fly.io** - `fly deploy`
- **Vercel** - Serverless (needs adaptation)

Make sure to:
1. Set all environment variables
2. Update OAuth redirect URI to production URL
3. Update Slack webhook URL to production URL
4. Enable HTTPS

---

## Architecture

```
┌─────────────┐     ┌─────────────┐
│   Gmail     │────▶│   Pub/Sub   │
│   Account   │     │   Topic     │
└─────────────┘     └──────┬──────┘
                           │
                           ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Slack     │────▶│   Server    │────▶│  Supabase   │
│   Workspace │     │  (Node.js)  │     │  Database   │
└─────────────┘     └─────────────┘     └─────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │   Chrome    │
                    │  Extension  │
                    └─────────────┘
```

---

## Troubleshooting

### Gmail not syncing?
- Check refresh token is set in `.env`
- Verify Gmail API is enabled in Google Cloud Console
- Check OAuth scopes include `gmail.readonly`

### Slack messages not appearing?
- Verify webhook URL is correct and publicly accessible
- Check signing secret matches
- Ensure `message.im` event is subscribed
- Bot must be invited to the conversation (for non-DM channels)

### Duplicates appearing?
- Run the migration to add the `message_id` unique index
- Check the `message_id` column exists in your table

---

## License

MIT
