# WhatsApp News Bot - Migration Checklist

## 🚨 Critical Database Updates Required

The WhatsApp connection instability is caused by missing database columns. Run these migrations immediately.

---

## ✅ Immediate Fix (Run These Commands)

```bash
cd whatsapp-news-bot-main

# 1. Check current migration status
npm run db:check

# 2. Run all pending migrations
npm run db:migrate

# 3. Verify all migrations applied
npm run db:check
```

---

## 📋 Required Migrations

### Migration 011: WhatsApp Session Lease System
**File**: `scripts/011_auth_state_leases_and_status.sql`
**Purpose**: Prevents multiple instances from fighting over WhatsApp session

**Changes**:
- `auth_state.lease_owner` - ID of instance holding session
- `auth_state.lease_expires_at` - When lease expires
- `idx_auth_state_lease_expires_at` - Index for lease queries
- Updates status constraint to include 'conflict'

### Migration 012: Schedule Queue Cursor
**File**: `scripts/012_schedule_queue_cursor.sql`
**Purpose**: Tracks last queued position to prevent duplicate processing

**Changes**:
- `schedules.last_queued_at` - Timestamp of last item queued
- `idx_schedules_last_queued_at` - Performance index

---

## 🔍 Manual Verification

**If migrations fail**, run this SQL in Supabase Dashboard:

```sql
-- Check if lease columns exist
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'auth_state' 
AND column_name IN ('lease_owner', 'lease_expires_at');

-- Add lease columns if missing
ALTER TABLE auth_state 
ADD COLUMN IF NOT EXISTS lease_owner TEXT,
ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

-- Add queue cursor if missing
ALTER TABLE schedules 
ADD COLUMN IF NOT EXISTS last_queued_at TIMESTAMPTZ;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_auth_state_lease_expires 
ON auth_state(lease_expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_schedules_last_queued_at 
ON schedules(last_queued_at DESC);

-- Update status constraint to include 'conflict'
ALTER TABLE auth_state 
DROP CONSTRAINT IF EXISTS auth_state_status_check;

ALTER TABLE auth_state 
ADD CONSTRAINT auth_state_status_check 
CHECK (status IN ('disconnected', 'connecting', 'qr', 'qr_ready', 'connected', 'error', 'conflict'));
```

---

## ✅ Expected Outcome

After applying migrations:

1. **Lease system activates** - Only one instance connects to WhatsApp
2. **Instance fighting stops** - No more "Conflict/replaced" errors  
3. **Connection stabilizes** - WhatsApp stays connected reliably
4. **Queue cursor works** - Prevents duplicate message processing

---

## 🔧 Troubleshooting

### Migration Fails

**Error**: "relation 'auth_state' does not exist"
- Run `001_create_schema.sql` first
- Then rerun migrations

**Error**: "column already exists" 
- Normal if column exists, migration uses `IF NOT EXISTS`

**Error**: "constraint already exists"
- Run `011_auth_state_leases_and_status.sql` manually (it handles dropping constraints)

### WhatsApp Still Unstable After Migrations

1. Wait 2-3 minutes for lease system to activate
2. Check logs: should show "Acquired WhatsApp session lease"
3. If still fighting, manually clear auth_state:
   ```sql
   DELETE FROM auth_state WHERE id = 'baileys_auth';
   ```
4. Restart service via Render dashboard

### Check Migration Status

```bash
# Run the checker script
npm run db:check

# Expected output:
# ✅ auth_state.lease_owner column
# ✅ auth_state.lease_expires_at column  
# ✅ schedules.last_queued_at column
# ✅ auth_state status constraint (includes conflict)
# ✅ message_logs unique dispatch constraint
# ✅ schema_migrations table
```

---

## 📞 Support

If issues persist:

1. Check migration script output carefully
2. Verify Supabase connection string is correct
3. Ensure Render environment has `DATABASE_URL` set
4. Review Supabase logs for SQL errors

**Migration script location**: `server/src/scripts/migrate.ts`  
**Database config**: `server/.env` → `DATABASE_URL`

---

## 🚀 Next Steps After Migration

1. **Monitor logs** - Watch for lease acquisition messages
2. **Test WhatsApp** - Reconnect if needed via UI
3. **Verify queue** - Check that messages process correctly
4. **Update monitoring** - Set alerts for instance conflicts

The system should stabilize within 2-3 minutes after migrations complete.