-- Add columns needed for automation (magic links + duplicate protection)
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS url TEXT;
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS message_id TEXT;

-- Create index for faster duplicate checking
CREATE INDEX IF NOT EXISTS idx_pending_actions_message_id ON pending_actions(message_id);
