# Slack Integration Setup Guide

This guide walks you through connecting Slack DMs to your Communication Triage system.

---

## Overview

When someone sends you a direct message on Slack, it will automatically appear in your Chrome extension sidebar with a direct link back to the conversation.

---

## Step 1: Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App**
3. Choose **From scratch**
4. Enter:
   - **App Name**: `Triage Bot` (or whatever you prefer)
   - **Workspace**: Select your workspace
5. Click **Create App**

---

## Step 2: Configure Bot Permissions

1. In your app settings, go to **OAuth & Permissions**
2. Scroll to **Scopes** → **Bot Token Scopes**
3. Add these scopes:

| Scope | Purpose |
|-------|---------|
| `users:read` | Get sender's real name |
| `im:history` | Read DM history |
| `im:read` | Access DM conversations |

4. Scroll up and click **Install to Workspace**
5. Click **Allow** to authorize
6. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

Add to your `.env`:
```
SLACK_BOT_TOKEN=xoxb-your-token-here
```

---

## Step 3: Get Signing Secret

1. Go to **Basic Information** in your app settings
2. Scroll to **App Credentials**
3. Copy the **Signing Secret**

Add to your `.env`:
```
SLACK_SIGNING_SECRET=your-signing-secret-here
```

---

## Step 4: Enable Event Subscriptions

1. Go to **Event Subscriptions** in your app settings
2. Toggle **Enable Events** to **On**
3. For **Request URL**, enter your server's webhook endpoint:

   **Local testing (with ngrok)**:
   ```
   https://your-ngrok-url.ngrok.io/slack/webhook
   ```

   **Production**:
   ```
   https://your-app.up.railway.app/slack/webhook
   ```

4. Slack will send a verification request - your server handles this automatically

5. Under **Subscribe to bot events**, click **Add Bot User Event**
6. Add: `message.im` (Direct messages to your bot)

7. Click **Save Changes**

---

## Step 5: Test the Integration

### Option A: Using ngrok (Local Testing)

1. Install ngrok: `brew install ngrok` (Mac) or download from ngrok.com
2. Start your server: `npm start`
3. In another terminal: `ngrok http 3000`
4. Copy the `https://` URL from ngrok
5. Update your Slack app's Request URL with the ngrok URL
6. Send yourself a DM in Slack

### Option B: Deploy First

1. Deploy your server (see DEPLOY.md)
2. Use your production URL as the Request URL
3. Send yourself a DM in Slack

---

## How It Works

```
┌─────────────────┐
│  Someone DMs    │
│   you on Slack  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Slack sends   │
│  event to your  │
│     server      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Server saves   │
│  to Supabase    │
│  pending_actions│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Realtime pushes│
│  to your Chrome │
│   extension     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  New card with  │
│  "Open in Slack"│
│     link!       │
└─────────────────┘
```

---

## What Gets Captured

For each DM, the system saves:

| Field | Value |
|-------|-------|
| `sender` | Person's real name (or username if unavailable) |
| `summary` | First 100 characters of the message |
| `url` | Deep link to open the conversation in Slack |
| `platform` | `slack` |
| `message_id` | Unique ID to prevent duplicates |

---

## Troubleshooting

### "Invalid signature" errors
- Double-check your `SLACK_SIGNING_SECRET` matches exactly
- Make sure there are no extra spaces

### Events not being received
1. Check Event Subscriptions shows a green checkmark
2. Verify your server is running and accessible
3. Check server logs for incoming requests

### Bot not seeing DMs
- The bot needs to be part of the conversation
- For DMs with your bot, message it directly
- For DMs between you and others, you'll need different scopes

### Duplicate messages appearing
- The system uses `message_id` to prevent duplicates
- Make sure your Supabase migration ran successfully

---

## Security Notes

- **Never commit** your `SLACK_SIGNING_SECRET` or `SLACK_BOT_TOKEN` to Git
- Use environment variables for all secrets
- The signing secret verification prevents spoofed requests
- Your bot only sees DMs it's part of (not all your DMs with others)

---

## Optional: Customize What Gets Captured

Edit `server.js` to modify what's saved:

```javascript
// In the /slack/webhook handler:
await saveToSupabase({
  sender: senderName,
  summary: text.substring(0, 200), // Capture more text
  url: createSlackLink(teamId, channelId, messageTs),
  platform: 'slack',
  messageId: `${teamId}-${channelId}-${messageTs}`,
  priority: text.includes('urgent') ? 'urgent' : 'normal' // Auto-detect urgency
});
```
