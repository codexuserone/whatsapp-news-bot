-- Auth state: session lease + expanded statuses

ALTER TABLE auth_state
  ADD COLUMN IF NOT EXISTS lease_owner TEXT,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_auth_state_lease_expires_at
  ON auth_state(lease_expires_at DESC);

-- The WhatsApp client uses additional statuses beyond the original schema.
ALTER TABLE auth_state
  DROP CONSTRAINT IF EXISTS auth_state_status_check;

ALTER TABLE auth_state
  ADD CONSTRAINT auth_state_status_check
  CHECK (status IN (
    'disconnected',
    'connecting',
    'connected',
    'qr_ready',
    'conflict',
    'error'
  ));
