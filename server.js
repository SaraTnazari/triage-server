/**
 * Communication Triage Automation Server (Multi-User)
 *
 * This server automatically captures incoming emails and Slack DMs,
 * saving them to your Supabase pending_actions table for triage.
 *
 * Each user connects their own Gmail and Slack through the Chrome extension.
 * Tokens are stored per-user in Supabase tables.
 *
 * Features:
 * - Per-user Gmail OAuth + push notifications
 * - Per-user Slack OAuth + DM webhook
 * - Duplicate protection (won't add the same message twice)
 * - Direct "magic" links to open emails/messages with one click
 */

import 'dotenv/config';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { google } from 'googleapis';
import crypto from 'crypto';

// ============================================
// CONFIGURATION
// ============================================
const PORT = process.env.PORT || 3000;

// Service role key bypasses RLS (server is trusted, inserts on behalf of users)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Gmail OAuth2 client (shared config, per-user tokens)
const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  process.env.GMAIL_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`
);

// ============================================
// EMAIL FILTER CONFIGURATION
// ============================================
const EXCLUDED_LABELS = [
  'CATEGORY_PROMOTIONS',
  'CATEGORY_SOCIAL',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
  'SPAM',
  'TRASH'
];

function shouldIncludeEmail(senderEmail, labelIds = []) {
  for (const excludedLabel of EXCLUDED_LABELS) {
    if (labelIds.includes(excludedLabel)) {
      console.log(`⏭️  Filtered out (${excludedLabel}): ${senderEmail}`);
      return false;
    }
  }
  return labelIds.includes('INBOX');
}

const app = express();

// CORS - Allow requests from Chrome extension
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, apikey');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Create an OAuth2Client for a specific user using their stored refresh token
 */
function createUserOAuth2Client(refreshToken) {
  const userClient = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`
  );
  userClient.setCredentials({ refresh_token: refreshToken });
  return userClient;
}

/**
 * Check if a message already exists in the database (duplicate protection)
 */
async function isDuplicate(messageLink, platform) {
  if (!messageLink) return false;
  const { data, error } = await supabase
    .from('pending_actions')
    .select('id')
    .eq('message_link', messageLink)
    .eq('platform_tag', platform)
    .limit(1);
  if (error) {
    console.error('Error checking for duplicate:', error);
    return false;
  }
  return data && data.length > 0;
}

function createGmailLink(messageId) {
  return `https://mail.google.com/mail/u/0/#inbox/${messageId}`;
}

function createSlackLink(teamId, channelId, messageTs) {
  return `https://slack.com/app_redirect?team=${teamId}&channel=${channelId}&message_ts=${messageTs}`;
}

function extractEmailHeaders(message) {
  const headers = message.payload?.headers || [];
  const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
  return {
    from: getHeader('From'),
    subject: getHeader('Subject'),
    date: getHeader('Date'),
    messageId: getHeader('Message-ID')
  };
}

function parseSenderName(fromHeader) {
  if (!fromHeader) return 'Unknown Sender';
  const match = fromHeader.match(/^(.+?)\s*<.+>$/);
  if (match) return match[1].replace(/"/g, '').trim();
  const emailMatch = fromHeader.match(/<(.+)>/);
  if (emailMatch) return emailMatch[1];
  return fromHeader;
}

/**
 * Save a message to Supabase (multi-user: requires user_id)
 */
async function saveToSupabase({ sender, summary, url, platform, messageId, user_id }) {
  if (await isDuplicate(url, platform)) {
    console.log(`⏭️  Skipping duplicate: ${url}`);
    return { skipped: true, reason: 'duplicate' };
  }

  const task_text = `${sender}: ${summary}`;

  const { data, error } = await supabase
    .from('pending_actions')
    .insert([{
      task_text,
      platform_tag: platform,
      sender_name: sender,
      message_link: url,
      user_id: user_id
    }])
    .select();

  if (error) {
    console.error('❌ Supabase insert error:', error);
    throw error;
  }

  console.log(`✅ Saved for user ${user_id}: ${task_text.substring(0, 60)}...`);
  return { data, skipped: false };
}

// ============================================
// GMAIL OAUTH (per-user)
// ============================================

/**
 * GET /auth/google?user_id=UUID
 * Start Google OAuth flow — user_id is encoded in state
 */
app.get('/auth/google', (req, res) => {
  const { user_id } = req.query;
  if (!user_id) {
    return res.status(400).send('Missing user_id parameter. Connect Gmail from the extension.');
  }

  const state = Buffer.from(JSON.stringify({ user_id })).toString('base64');

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.metadata'
    ],
    prompt: 'consent',
    state: state
  });

  res.redirect(authUrl);
});

/**
 * GET /auth/google/callback
 * Handle OAuth callback — store refresh token per user in Supabase
 */
app.get('/auth/google/callback', async (req, res) => {
  const { code, state } = req.query;

  try {
    // Decode user_id from state
    const { user_id } = JSON.parse(Buffer.from(state, 'base64').toString());

    const { tokens } = await oauth2Client.getToken(code);

    // Create a temporary client to get the user's email
    const tempClient = createUserOAuth2Client(tokens.refresh_token);
    const tempGmail = google.gmail({ version: 'v1', auth: tempClient });
    const profile = await tempGmail.users.getProfile({ userId: 'me' });
    const emailAddress = profile.data.emailAddress;

    // Store in database
    const { error } = await supabase
      .from('user_gmail_tokens')
      .upsert({
        user_id,
        email_address: emailAddress,
        refresh_token: tokens.refresh_token
      }, { onConflict: 'email_address' });

    if (error) {
      console.error('Error storing Gmail token:', error);
      throw error;
    }

    console.log(`✅ Gmail connected for ${emailAddress} (user: ${user_id})`);

    res.send(`
      <html>
      <body style="font-family: -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: white;">
        <div style="text-align: center;">
          <h1>Gmail Connected!</h1>
          <p>Connected: ${emailAddress}</p>
          <p style="color: #888;">You can close this window and go back to the extension.</p>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    console.error('Gmail OAuth error:', error);
    res.status(500).send(`
      <html>
      <body style="font-family: -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: white;">
        <div style="text-align: center;">
          <h1>Connection Failed</h1>
          <p style="color: #ff6b6b;">${error.message}</p>
          <p style="color: #888;">Please try again from the extension.</p>
        </div>
      </body>
      </html>
    `);
  }
});

// ============================================
// GMAIL WEBHOOK (multi-user)
// ============================================

/**
 * POST /gmail/webhook
 * Receive push notifications from Gmail via Pub/Sub
 * Looks up user by email address from the notification
 */
app.post('/gmail/webhook', async (req, res) => {
  try {
    const data = req.body.message?.data;
    if (!data) return res.status(200).send('No data');

    const decoded = JSON.parse(Buffer.from(data, 'base64').toString());
    console.log('📨 Gmail notification:', decoded);

    const { emailAddress } = decoded;

    // Look up user by email address
    const { data: tokenRecord, error: lookupError } = await supabase
      .from('user_gmail_tokens')
      .select('user_id, refresh_token')
      .eq('email_address', emailAddress)
      .single();

    if (lookupError || !tokenRecord) {
      console.log(`❌ No user found for email: ${emailAddress}`);
      return res.status(200).send('OK');
    }

    const { user_id, refresh_token } = tokenRecord;

    // Create OAuth client for this user
    const userAuth = createUserOAuth2Client(refresh_token);
    const userGmail = google.gmail({ version: 'v1', auth: userAuth });

    // Fetch recent messages (simpler approach - just sync last 5 messages)
    const response = await userGmail.users.messages.list({
      userId: 'me',
      labelIds: ['INBOX'],
      maxResults: 5
    });

    const messages = response.data.messages || [];
    let processed = 0;

    for (const msg of messages) {
      const message = await userGmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date', 'Message-ID']
      });

      const headers = extractEmailHeaders(message.data);
      const senderName = parseSenderName(headers.from);
      const labelIds = message.data.labelIds || [];

      // Check if email should be included (not promotion/spam)
      if (!shouldIncludeEmail(headers.from, labelIds)) continue;

      // Try to save - duplicate protection will prevent re-adding existing emails
      const result = await saveToSupabase({
        sender: senderName,
        summary: headers.subject || '(No Subject)',
        url: createGmailLink(msg.id),
        platform: 'gmail',
        messageId: headers.messageId || msg.id,
        user_id: user_id
      });

      if (!result.skipped) processed++;
    }

    console.log(`✅ Webhook processed ${processed} new emails for ${emailAddress}`);
    res.status(200).send('OK');
  } catch (error) {
    console.error('Gmail webhook error:', error);
    res.status(200).send('Error logged');
  }
});

/**
 * POST /gmail/sync
 * Manually sync recent emails for a specific user
 */
app.post('/gmail/sync', async (req, res) => {
  try {
    const { user_id, maxResults = 10 } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'Missing user_id' });
    }

    // Get user's Gmail token
    const { data: tokenRecord } = await supabase
      .from('user_gmail_tokens')
      .select('refresh_token, email_address')
      .eq('user_id', user_id)
      .single();

    if (!tokenRecord) {
      return res.status(404).json({ error: 'Gmail not connected for this user' });
    }

    const userAuth = createUserOAuth2Client(tokenRecord.refresh_token);
    const userGmail = google.gmail({ version: 'v1', auth: userAuth });

    const response = await userGmail.users.messages.list({
      userId: 'me',
      labelIds: ['INBOX'],
      maxResults
    });

    const messages = response.data.messages || [];
    const results = [];
    let filtered = 0;

    for (const msg of messages) {
      const message = await userGmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date', 'Message-ID']
      });

      const headers = extractEmailHeaders(message.data);
      const senderName = parseSenderName(headers.from);
      const labelIds = message.data.labelIds || [];

      if (!shouldIncludeEmail(headers.from, labelIds)) {
        filtered++;
        continue;
      }

      const result = await saveToSupabase({
        sender: senderName,
        summary: headers.subject || '(No Subject)',
        url: createGmailLink(msg.id),
        platform: 'gmail',
        messageId: headers.messageId || msg.id,
        user_id: user_id
      });

      results.push({ sender: senderName, subject: headers.subject, ...result });
    }

    res.json({
      success: true,
      processed: results.length,
      filtered,
      message: `Added ${results.length} emails, filtered out ${filtered} promotional/social`,
      results
    });
  } catch (error) {
    console.error('Gmail sync error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /gmail/watch
 * Set up Gmail push notifications for a specific user
 */
app.post('/gmail/watch', async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'Missing user_id' });
    }

    const { data: tokenRecord } = await supabase
      .from('user_gmail_tokens')
      .select('refresh_token')
      .eq('user_id', user_id)
      .single();

    if (!tokenRecord) {
      return res.status(404).json({ error: 'Gmail not connected for this user' });
    }

    const userAuth = createUserOAuth2Client(tokenRecord.refresh_token);
    const userGmail = google.gmail({ version: 'v1', auth: userAuth });

    const response = await userGmail.users.watch({
      userId: 'me',
      requestBody: {
        topicName: process.env.GMAIL_PUBSUB_TOPIC,
        labelIds: ['INBOX']
      }
    });

    console.log(`📬 Gmail watch started for user ${user_id}:`, response.data);
    res.json({
      success: true,
      message: 'Gmail watch activated',
      historyId: response.data.historyId,
      expiration: response.data.expiration
    });
  } catch (error) {
    console.error('Gmail watch error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// SLACK OAUTH (per-user)
// ============================================

/**
 * GET /auth/slack?user_id=UUID
 * Start Slack OAuth flow — user_id is encoded in state
 */
app.get('/auth/slack', (req, res) => {
  const { user_id } = req.query;
  if (!user_id) {
    return res.status(400).send('Missing user_id parameter. Connect Slack from the extension.');
  }

  const state = Buffer.from(JSON.stringify({ user_id })).toString('base64');
  const redirectUri = process.env.SLACK_REDIRECT_URI || `http://localhost:${PORT}/auth/slack/callback`;

  const params = new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID,
    scope: 'channels:read,im:history,im:read,users:read',
    redirect_uri: redirectUri,
    state: state
  });

  const slackAuthUrl = `https://slack.com/oauth/v2/authorize?${params.toString()}`;
  console.log('🔗 Slack OAuth URL:', slackAuthUrl);
  res.redirect(slackAuthUrl);
});

/**
 * GET /auth/slack/test?user_id=UUID
 * Debug endpoint — shows the Slack OAuth URL instead of redirecting
 */
app.get('/auth/slack/test', (req, res) => {
  const user_id = req.query.user_id || 'test-user-id';
  const state = Buffer.from(JSON.stringify({ user_id })).toString('base64');
  const redirectUri = process.env.SLACK_REDIRECT_URI || `http://localhost:${PORT}/auth/slack/callback`;

  const params = new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID,
    scope: 'channels:read,im:history,im:read,users:read',
    redirect_uri: redirectUri,
    state: state
  });

  const slackAuthUrl = `https://slack.com/oauth/v2/authorize?${params.toString()}`;
  res.json({
    url: slackAuthUrl,
    client_id: process.env.SLACK_CLIENT_ID,
    redirect_uri: redirectUri,
    scopes: 'channels:read,im:history,im:read,users:read',
    state: state
  });
});

/**
 * GET /auth/slack/callback
 * Handle Slack OAuth callback — store bot token per user
 */
app.get('/auth/slack/callback', async (req, res) => {
  const { code, state } = req.query;

  try {
    const { user_id } = JSON.parse(Buffer.from(state, 'base64').toString());

    // Exchange code for token
    const response = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.SLACK_CLIENT_ID,
        client_secret: process.env.SLACK_CLIENT_SECRET,
        code: code,
        redirect_uri: process.env.SLACK_REDIRECT_URI || `http://localhost:${PORT}/auth/slack/callback`
      })
    });

    const data = await response.json();

    if (!data.ok) {
      throw new Error(data.error);
    }

    // Store token in database
    const { error } = await supabase
      .from('user_slack_tokens')
      .upsert({
        user_id,
        team_id: data.team.id,
        team_name: data.team.name,
        bot_token: data.access_token
      }, { onConflict: 'user_id,team_id' });

    if (error) {
      console.error('Error storing Slack token:', error);
      throw error;
    }

    console.log(`✅ Slack connected for workspace "${data.team.name}" (user: ${user_id})`);

    res.send(`
      <html>
      <body style="font-family: -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: white;">
        <div style="text-align: center;">
          <h1>Slack Connected!</h1>
          <p>Workspace: ${data.team.name}</p>
          <p style="color: #888;">You can close this window and go back to the extension.</p>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    console.error('Slack OAuth error:', error);
    res.status(500).send(`
      <html>
      <body style="font-family: -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: white;">
        <div style="text-align: center;">
          <h1>Connection Failed</h1>
          <p style="color: #ff6b6b;">${error.message}</p>
          <p style="color: #888;">Please try again from the extension.</p>
        </div>
      </body>
      </html>
    `);
  }
});

// ============================================
// SLACK WEBHOOK (multi-user)
// ============================================

function verifySlackSignature(req) {
  const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;
  if (!slackSigningSecret) return true;

  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];

  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (parseInt(timestamp) < fiveMinutesAgo) return false;

  const sigBasestring = 'v0:' + timestamp + ':' + JSON.stringify(req.body);
  const mySignature = 'v0=' + crypto
    .createHmac('sha256', slackSigningSecret)
    .update(sigBasestring)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(mySignature),
    Buffer.from(signature)
  );
}

/**
 * POST /slack/webhook
 * Receive events from Slack — looks up user by team_id
 */
app.post('/slack/webhook', async (req, res) => {
  if (req.body.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }

  if (!verifySlackSignature(req)) {
    console.warn('⚠️ Invalid Slack signature');
    return res.status(401).send('Invalid signature');
  }

  const event = req.body.event;

  if (event?.type === 'message' && event?.channel_type === 'im') {
    if (event.bot_id || event.subtype) {
      return res.status(200).send('OK');
    }

    try {
      const teamId = req.body.team_id;
      const channelId = event.channel;
      const messageTs = event.ts;
      const slackUserId = event.user;
      const text = event.text || '(No message text)';

      // Look up which user owns this workspace
      const { data: tokenRecord } = await supabase
        .from('user_slack_tokens')
        .select('user_id, bot_token')
        .eq('team_id', teamId)
        .single();

      if (!tokenRecord) {
        console.log(`❌ No user found for Slack team: ${teamId}`);
        return res.status(200).send('OK');
      }

      const { user_id, bot_token } = tokenRecord;

      // Get sender name using this user's bot token
      let senderName = slackUserId;
      try {
        const userResponse = await fetch(`https://slack.com/api/users.info?user=${slackUserId}`, {
          headers: { 'Authorization': `Bearer ${bot_token}` }
        });
        const userData = await userResponse.json();
        if (userData.ok) {
          senderName = userData.user?.real_name || userData.user?.name || slackUserId;
        }
      } catch (e) {
        console.warn('Could not fetch Slack user info:', e);
      }

      const summary = text.length > 100 ? text.substring(0, 100) + '...' : text;

      await saveToSupabase({
        sender: senderName,
        summary,
        url: createSlackLink(teamId, channelId, messageTs),
        platform: 'slack',
        messageId: `${teamId}-${channelId}-${messageTs}`,
        user_id: user_id
      });

      console.log(`💬 Slack DM for user ${user_id} from ${senderName}: ${summary.substring(0, 50)}...`);
    } catch (error) {
      console.error('Slack processing error:', error);
    }
  }

  res.status(200).send('OK');
});

// ============================================
// UTILITY ENDPOINTS
// ============================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    supabase: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    gmail_oauth: !!process.env.GMAIL_CLIENT_ID,
    slack_oauth: !!process.env.SLACK_CLIENT_ID
  });
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║      Communication Triage Server (Multi-User)              ║
╠════════════════════════════════════════════════════════════╣
║  Server: http://localhost:${PORT}                             ║
║                                                            ║
║  ENDPOINTS:                                                ║
║  • GET  /auth/google       - Gmail OAuth (per user)        ║
║  • GET  /auth/slack        - Slack OAuth (per user)        ║
║  • POST /gmail/webhook     - Gmail push notifications      ║
║  • POST /gmail/sync        - Manual email sync             ║
║  • POST /gmail/watch       - Enable Gmail push             ║
║  • POST /slack/webhook     - Slack event receiver          ║
║  • GET  /health            - Health check                  ║
║                                                            ║
║  STATUS:                                                   ║
║  • Supabase: ${process.env.SUPABASE_SERVICE_ROLE_KEY ? '✅ Connected' : '❌ Missing'}                              ║
║  • Gmail OAuth: ${process.env.GMAIL_CLIENT_ID ? '✅ Configured' : '❌ Missing GMAIL_CLIENT_ID'}                       ║
║  • Slack OAuth: ${process.env.SLACK_CLIENT_ID ? '✅ Configured' : '⚠️  Not configured'}                       ║
╚════════════════════════════════════════════════════════════╝
  `);
});

export default app;
