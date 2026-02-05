-- Migration: Update auth_state status constraint to include 'conflict'
-- The lease system uses 'conflict' status when another instance holds the session

ALTER TABLE auth_state 
DROP CONSTRAINT IF EXISTS auth_state_status_check;

ALTER TABLE auth_state 
ADD CONSTRAINT auth_state_status_check 
CHECK (status IN ('disconnected', 'connecting', 'qr', 'qr_ready', 'connected', 'error', 'conflict'));
