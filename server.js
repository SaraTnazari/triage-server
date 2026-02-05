/**
 * Communication Triage Automation Server
 *
 * This server automatically captures incoming emails and Slack DMs,
 * saving them to your Supabase pending_actions table for triage.
 *
 * Features:
 * - Gmail API push notifications (real-time email alerts)
 * - Slack webhook for DMs
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
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// Gmail OAuth2 client setup
const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  process.env.GMAIL_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`
);

// Set credentials if refresh token exists
if (process.env.GMAIL_REFRESH_TOKEN) {
  oauth2Client.setCredentials({
    refresh_token: process.env.GMAIL_REFRESH_TOKEN
  });
}

const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

const app = express();

// CORS - Allow requests from Chrome extension and any origin
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, apikey');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Check if a message already exists in the database (duplicate protection)
 */
async function isDuplicate(messageId, platform) {
  const { data, error } = await supabase
    .from('pending_actions')
    .select('id')
    .eq('message_id', messageId)
    .eq('platform', platform)
    .limit(1);

  if (error) {
    console.error('Error checking for duplicate:', error);
    return false; // Allow insert on error to not lose messages
  }

  return data && data.length > 0;
}

/**
 * Create a direct Gmail link for the message
 */
function createGmailLink(messageId) {
  // Gmail web link format
  return `https://mail.google.com/mail/u/0/#inbox/${messageId}`;
}

/**
 * Create a direct Slack link for the message
 */
function createSlackLink(teamId, channelId, messageTs) {
  // Slack deep link format
  const tsFormatted = messageTs.replace('.', '');
  return `https://slack.com/app_redirect?team=${teamId}&channel=${channelId}&message_ts=${messageTs}`;
}

/**
 * Extract email headers from Gmail message
 */
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

/**
 * Parse sender name from email "From" header
 * e.g., "John Doe <john@example.com>" -> "John Doe"
 */
function parseSenderName(fromHeader) {
  if (!fromHeader) return 'Unknown Sender';

  // Try to extract name before email
  const match = fromHeader.match(/^(.+?)\s*<.+>$/);
  if (match) {
    return match[1].replace(/"/g, '').trim();
  }

  // If no name, extract email
  const emailMatch = fromHeader.match(/<(.+)>/);
  if (emailMatch) {
    return emailMatch[1];
  }

  return fromHeader;
}

/**
 * Save a message to Supabase
 */
async function saveToSupabase({ sender, summary, url, platform, messageId }) {
  // Check for duplicates first
  if (await isDuplicate(messageId, platform)) {
    console.log(`⏭️  Skipping duplicate: ${messageId}`);
    return { skipped: true, reason: 'duplicate' };
  }

  const { data, error } = await supabase
    .from('pending_actions')
    .insert([{
      sender,
      summary,
      url,
      platform,
      message_id: messageId,
      created_at: new Date().toISOString()
    }])
    .select();

  if (error) {
    console.error('❌ Supabase insert error:', error);
    throw error;
  }

  console.log(`✅ Saved: ${sender} - ${summary.substring(0, 50)}...`);
  return { data, skipped: false };
}

// ============================================
// GMAIL INTEGRATION
// ============================================

/**
 * GET /auth/google
 * Start Google OAuth flow to get Gmail access
 */
app.get('/auth/google', (req, res) => {
  const scopes = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.metadata'
  ];

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent' // Force consent to get refresh token
  });

  res.redirect(authUrl);
});

/**
 * GET /auth/google/callback
 * Handle OAuth callback and store tokens
 */
app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    console.log('\n🔑 GMAIL TOKENS RECEIVED!');
    console.log('Add this to your .env file:');
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('');

    res.send(`
      <h1>Gmail Connected!</h1>
      <p>Add this refresh token to your .env file:</p>
      <code style="background:#f0f0f0;padding:10px;display:block;word-break:break-all;">
        GMAIL_REFRESH_TOKEN=${tokens.refresh_token}
      </code>
      <p>Then restart the server and call <code>POST /gmail/watch</code> to start listening for emails.</p>
    `);
  } catch (error) {
    console.error('OAuth error:', error);
    res.status(500).send('Authentication failed: ' + error.message);
  }
});

/**
 * POST /gmail/watch
 * Set up Gmail push notifications via Pub/Sub
 */
app.post('/gmail/watch', async (req, res) => {
  try {
    const response = await gmail.users.watch({
      userId: 'me',
      requestBody: {
        topicName: process.env.GMAIL_PUBSUB_TOPIC,
        labelIds: ['INBOX']
      }
    });

    console.log('📬 Gmail watch started:', response.data);
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

/**
 * POST /gmail/webhook
 * Receive push notifications from Gmail via Pub/Sub
 */
app.post('/gmail/webhook', async (req, res) => {
  try {
    // Pub/Sub sends base64-encoded data
    const data = req.body.message?.data;
    if (!data) {
      return res.status(200).send('No data');
    }

    const decoded = JSON.parse(Buffer.from(data, 'base64').toString());
    console.log('📨 Gmail notification:', decoded);

    const { emailAddress, historyId } = decoded;

    // Fetch recent history to get new messages
    const history = await gmail.users.history.list({
      userId: 'me',
      startHistoryId: historyId,
      historyTypes: ['messageAdded']
    });

    const messages = history.data.history || [];

    for (const historyItem of messages) {
      for (const added of (historyItem.messagesAdded || [])) {
        const messageId = added.message.id;

        // Fetch full message details
        const message = await gmail.users.messages.get({
          userId: 'me',
          id: messageId,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Date', 'Message-ID']
        });

        // Only process unread messages in inbox
        if (!message.data.labelIds?.includes('UNREAD')) {
          continue;
        }

        const headers = extractEmailHeaders(message.data);
        const senderName = parseSenderName(headers.from);

        await saveToSupabase({
          sender: senderName,
          summary: headers.subject || '(No Subject)',
          url: createGmailLink(messageId),
          platform: 'gmail',
          messageId: headers.messageId || messageId
        });
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Gmail webhook error:', error);
    res.status(200).send('Error logged'); // Return 200 to prevent Pub/Sub retries
  }
});

/**
 * POST /gmail/sync
 * Manually sync recent unread emails (useful for testing)
 */
app.post('/gmail/sync', async (req, res) => {
  try {
    const { maxResults = 10 } = req.body;

    // Fetch recent unread messages
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread in:inbox',
      maxResults
    });

    const messages = response.data.messages || [];
    const results = [];

    for (const msg of messages) {
      const message = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date', 'Message-ID']
      });

      const headers = extractEmailHeaders(message.data);
      const senderName = parseSenderName(headers.from);

      const result = await saveToSupabase({
        sender: senderName,
        summary: headers.subject || '(No Subject)',
        url: createGmailLink(msg.id),
        platform: 'gmail',
        messageId: headers.messageId || msg.id
      });

      results.push({
        sender: senderName,
        subject: headers.subject,
        ...result
      });
    }

    res.json({
      success: true,
      processed: results.length,
      results
    });
  } catch (error) {
    console.error('Gmail sync error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// SLACK INTEGRATION
// ============================================

/**
 * Verify Slack request signature
 */
function verifySlackSignature(req) {
  const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;
  if (!slackSigningSecret) return true; // Skip verification if not configured

  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];

  // Prevent replay attacks (request older than 5 minutes)
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (parseInt(timestamp) < fiveMinutesAgo) {
    return false;
  }

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
 * Receive events from Slack Event Subscriptions
 */
app.post('/slack/webhook', async (req, res) => {
  // Handle Slack URL verification challenge
  if (req.body.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }

  // Verify request is from Slack
  if (!verifySlackSignature(req)) {
    console.warn('⚠️ Invalid Slack signature');
    return res.status(401).send('Invalid signature');
  }

  const event = req.body.event;

  // Only process direct messages (DMs)
  if (event?.type === 'message' && event?.channel_type === 'im') {
    // Ignore bot messages and message edits
    if (event.bot_id || event.subtype) {
      return res.status(200).send('OK');
    }

    try {
      const teamId = req.body.team_id;
      const channelId = event.channel;
      const messageTs = event.ts;
      const userId = event.user;
      const text = event.text || '(No message text)';

      // Get user info for sender name
      let senderName = userId;
      if (process.env.SLACK_BOT_TOKEN) {
        try {
          const userResponse = await fetch(`https://slack.com/api/users.info?user=${userId}`, {
            headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` }
          });
          const userData = await userResponse.json();
          if (userData.ok) {
            senderName = userData.user?.real_name || userData.user?.name || userId;
          }
        } catch (e) {
          console.warn('Could not fetch user info:', e);
        }
      }

      // Create summary from message (truncate if too long)
      const summary = text.length > 100 ? text.substring(0, 100) + '...' : text;

      await saveToSupabase({
        sender: senderName,
        summary: summary,
        url: createSlackLink(teamId, channelId, messageTs),
        platform: 'slack',
        messageId: `${teamId}-${channelId}-${messageTs}`
      });

      console.log(`💬 Slack DM from ${senderName}: ${summary.substring(0, 50)}...`);
    } catch (error) {
      console.error('Slack processing error:', error);
    }
  }

  res.status(200).send('OK');
});

// ============================================
// UTILITY ENDPOINTS
// ============================================

/**
 * GET /health
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    gmail: !!process.env.GMAIL_REFRESH_TOKEN,
    slack: !!process.env.SLACK_SIGNING_SECRET
  });
});

/**
 * GET /pending
 * Get all pending actions (for testing)
 */
app.get('/pending', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pending_actions')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /pending/:id
 * Delete a pending action
 */
app.delete('/pending/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('pending_actions')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║      🎯 Communication Triage Server Running                ║
╠════════════════════════════════════════════════════════════╣
║  Server: http://localhost:${PORT}                             ║
║                                                            ║
║  ENDPOINTS:                                                ║
║  • GET  /auth/google      - Start Gmail OAuth              ║
║  • POST /gmail/watch      - Enable Gmail push              ║
║  • POST /gmail/webhook    - Gmail push notifications       ║
║  • POST /gmail/sync       - Manual email sync              ║
║  • POST /slack/webhook    - Slack event receiver           ║
║  • GET  /health           - Health check                   ║
║  • GET  /pending          - List pending actions           ║
║                                                            ║
║  STATUS:                                                   ║
║  • Gmail: ${process.env.GMAIL_REFRESH_TOKEN ? '✅ Connected' : '❌ Not connected - visit /auth/google'}       ║
║  • Slack: ${process.env.SLACK_SIGNING_SECRET ? '✅ Configured' : '⚠️  Not configured'}                        ║
║  • Supabase: ${process.env.SUPABASE_URL ? '✅ Configured' : '❌ Missing SUPABASE_URL'}                     ║
╚════════════════════════════════════════════════════════════╝
  `);
});

export default app;
