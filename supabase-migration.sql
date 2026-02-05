-- ============================================
-- SUPABASE MIGRATION FOR COMMUNICATION TRIAGE
-- ============================================
-- Run this in the Supabase SQL Editor

-- Add new columns for automation features
-- (Safe to run multiple times - uses IF NOT EXISTS)

-- Add platform column to distinguish message sources
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'pending_actions' AND column_name = 'platform') THEN
        ALTER TABLE pending_actions ADD COLUMN platform TEXT DEFAULT 'manual';
    END IF;
END $$;

-- Add message_id column for duplicate detection
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'pending_actions' AND column_name = 'message_id') THEN
        ALTER TABLE pending_actions ADD COLUMN message_id TEXT;
    END IF;
END $$;

-- Ensure we have the essential columns
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'pending_actions' AND column_name = 'sender') THEN
        ALTER TABLE pending_actions ADD COLUMN sender TEXT;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'pending_actions' AND column_name = 'summary') THEN
        ALTER TABLE pending_actions ADD COLUMN summary TEXT;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'pending_actions' AND column_name = 'url') THEN
        ALTER TABLE pending_actions ADD COLUMN url TEXT;
    END IF;
END $$;

-- Create unique index for duplicate protection
-- Prevents the same message from being added twice
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_actions_message_unique
ON pending_actions(message_id, platform)
WHERE message_id IS NOT NULL;

-- Create index for faster platform queries
CREATE INDEX IF NOT EXISTS idx_pending_actions_platform
ON pending_actions(platform);

-- Update the platform check constraint to include new platforms
-- First drop the old constraint if it exists
ALTER TABLE pending_actions
DROP CONSTRAINT IF EXISTS pending_actions_platform_tag_check;

-- Add the new constraint (if platform_tag column exists)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'pending_actions' AND column_name = 'platform_tag') THEN
        ALTER TABLE pending_actions
        ADD CONSTRAINT pending_actions_platform_tag_check
        CHECK (platform_tag IN ('slack', 'gmail', 'imessage', 'linkedin', 'whatsapp', 'manual'));
    END IF;
END $$;

-- Grant permissions (for Row Level Security if enabled)
-- This policy allows all operations for now (single-user use)
DO $$
BEGIN
    -- Only create policy if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'pending_actions' AND policyname = 'Allow all operations for automation') THEN
        CREATE POLICY "Allow all operations for automation" ON pending_actions
        FOR ALL USING (true) WITH CHECK (true);
    END IF;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Show current table structure
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'pending_actions'
ORDER BY ordinal_position;
