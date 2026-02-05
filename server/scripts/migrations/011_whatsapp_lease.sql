-- Migration 011: Add WhatsApp session lease columns
-- Prevents multiple bot instances from connecting simultaneously

ALTER TABLE auth_state 
ADD COLUMN IF NOT EXISTS lease_owner TEXT,
ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

-- Create index for lease queries
CREATE INDEX IF NOT EXISTS idx_auth_state_lease_expires ON auth_state(lease_expires_at);
