# WhatsApp News Bot - Operations Runbook

## Quick Reference

**Live URL**: https://whatsapp-news-bot-3-69qh.onrender.com  
**Health Check**: https://whatsapp-news-bot-3-69qh.onrender.com/health  
**API Docs**: https://whatsapp-news-bot-3-69qh.onrender.com/api-docs  
**Database**: Supabase (see .env for connection details)

---

## Critical Issues & Solutions

### Issue: Multiple Instances Fighting ("Conflict/replaced")

**Symptoms**:
- Logs show: `Conflict detected, another instance has the session`
- WhatsApp connects then immediately disconnects
- Two different hostnames appearing in logs

**Root Cause**: 
Render runs multiple instances during rolling deploys. Both try to connect to WhatsApp simultaneously.

**Solution**:
1. Ensure database migrations are applied:
   ```bash
   npm run db:migrate
   ```
   
2. This creates:
   - `lease_owner` column in `auth_state` table
   - `lease_expires_at` column with timestamp
   - Lease indexes for fast queries

3. The lease system will automatically coordinate instances

**Verify Fix**:
```bash
# Check if lease columns exist
curl https://whatsapp-news-bot-3-69qh.onrender.com/api/debug/leases
```

---

### Issue: "Could not find the 'lease_expires_at' column"

**Symptoms**:
- Error in logs: "column 'lease_expires_at' does not exist"
- Lease system not working
- Instances still fighting

**Solution**:
Run migrations immediately:
```bash
cd whatsapp-news-bot-main
npm run db:migrate
```

Or manually in Supabase SQL Editor:
```sql
-- Check if columns exist
SELECT column_name 
FROM information_schema.columns 
WHERE table_name = 'auth_state';

-- Add missing columns
ALTER TABLE auth_state 
ADD COLUMN IF NOT EXISTS lease_owner TEXT,
ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

-- Add index
CREATE INDEX IF NOT EXISTS idx_auth_state_lease_expires 
ON auth_state(lease_expires_at);
```

---

### Issue: WhatsApp Disconnected / QR Code Loop

**Symptoms**:
- Status shows "disconnected" or "error"
- Continuous QR code prompts
- "Session invalidated" errors

**Solution**:
1. Check current status:
   ```bash
   curl https://whatsapp-news-bot-3-69qh.onrender.com/api/whatsapp/status
   ```

2. If stuck, clear auth state:
   ```bash
   # Via API
   curl -X POST https://whatsapp-news-bot-3-69qh.onrender.com/api/whatsapp/disconnect
   
   # Or manually in Supabase:
   DELETE FROM auth_state WHERE id = 'baileys_auth';
   ```

3. Reconnect via UI:
   - Go to WhatsApp page in the app
   - Click "Reconnect"
   - Scan QR code with WhatsApp mobile app

---

### Issue: Messages Not Sending

**Symptoms**:
- Feeds are fetched but messages not delivered
- Queue shows items stuck in "pending"
- No errors in logs

**Checklist**:
1. WhatsApp connected? Check status endpoint
2. Targets configured? Verify in UI
3. Templates set up? Check Templates page
4. Schedules enabled? Check Schedules page
5. Rate limiting? Check if too many messages sent recently

**Debug**:
```bash
# Check queue status
curl https://whatsapp-news-bot-3-69qh.onrender.com/api/debug/queue

# Check recent logs
curl https://whatsapp-news-bot-3-69qh.onrender.com/api/logs?limit=50
```

---

### Issue: Feed Fetching Errors

**Symptoms**:
- Feeds showing "error" status
- "Failed to fetch" in logs
- SSL certificate errors

**Common Causes**:
1. **SSRF Protection**: Private IP addresses blocked (expected behavior)
2. **Rate Limiting**: Too many requests to same feed
3. **SSL Issues**: Certificate validation failing
4. **Timeout**: Feed taking too long to respond

**Solution**:
- Check feed URL is publicly accessible
- Verify feed uses valid SSL certificate
- Wait for rate limit to reset (1 minute)
- Check feed URL in browser

---

## Deployment

### Render Deployment

**Manual Deploy**:
1. Go to Render Dashboard
2. Select `whatsapp-news-bot-3` service
3. Click "Manual Deploy" → "Deploy latest commit"

**Environment Variables** (required):
```
DATABASE_URL=postgresql://...
SUPABASE_URL=https://...
SUPABASE_KEY=...
BASIC_AUTH_USER=admin      # optional
BASIC_AUTH_PASS=secret     # optional
SKIP_WHATSAPP_LEASE=false  # set true only for debugging
```

**Pre-deploy Checklist**:
- [ ] All migrations applied (`npm run db:migrate`)
- [ ] Tests passing (`npm test`)
- [ ] TypeScript compiles (`npm run typecheck`)
- [ ] Environment variables set in Render dashboard

---

## Database Operations

### Run Migrations

```bash
cd whatsapp-news-bot-main
npm run db:migrate
```

**What this does**:
1. Connects to Supabase using `DATABASE_URL`
2. Checks `schema_migrations` table for applied migrations
3. Runs any new `.sql` files from `scripts/` directory
4. Records applied migrations

### Check Migration Status

```sql
-- In Supabase SQL Editor
SELECT * FROM schema_migrations ORDER BY applied_at DESC;
```

### Reset Database (DANGER)

```sql
-- Drop all tables (USE WITH CAUTION)
DROP TABLE IF EXISTS schema_migrations, auth_state, chat_messages, 
  feed_items, feeds, logs, message_logs, schedules, settings, 
  targets, templates CASCADE;
```

Then re-run migrations:
```bash
npm run db:migrate
```

---

## Monitoring & Debugging

### Health Check

```bash
curl https://whatsapp-news-bot-3-69qh.onrender.com/health
```

Expected response:
```json
{
  "status": "healthy",
  "timestamp": "2026-02-05T...",
  "uptime": 12345
}
```

### WhatsApp Status

```bash
curl https://whatsapp-news-bot-3-69qh.onrender.com/api/whatsapp/status
```

### Debug Endpoints

```bash
# Queue status
curl https://whatsapp-news-bot-3-69qh.onrender.com/api/debug/queue

# Lease status (instances)
curl https://whatsapp-news-bot-3-69qh.onrender.com/api/debug/leases

# Recent logs
curl https://whatsapp-news-bot-3-69qh.onrender.com/api/logs?limit=100
```

---

## Log Analysis

### Common Log Patterns

**Instance Conflict**:
```
[WhatsAppService] Conflict detected, another instance has the session
[WhatsAppService] Conflict attempt 1/3, backing off for 15s
```
→ Normal during deploys, should resolve automatically

**Lease Acquired**:
```
[WhatsAppService] Acquired WhatsApp session lease
[WhatsAppService] Session info: { myJid: '...' }
```
→ Instance successfully got the session

**Rate Limited**:
```
[WhatsAppService] Rate limited, waiting...
```
→ Sending too fast, will retry automatically

**Feed Fetch Success**:
```
[FeedService] Fetched 15 items from https://...
```
→ Working normally

---

## Backup & Recovery

### Database Backup

**Automatic**: Supabase provides daily backups

**Manual**: Export via Supabase Dashboard → Database → Backups

### Auth State Backup

Before making changes, backup auth state:
```sql
-- Export auth state
COPY (SELECT * FROM auth_state) TO '/tmp/auth_state_backup.csv' CSV HEADER;

-- Export creds table if exists
COPY (SELECT * FROM auth_state_creds) TO '/tmp/auth_creds_backup.csv' CSV HEADER;
```

### Restore Auth State

```sql
-- Restore from backup
COPY auth_state FROM '/tmp/auth_state_backup.csv' CSV HEADER;
```

---

## Rate Limits

### WhatsApp Limits

- **Messages**: 1000/day per session (soft limit)
- **Connection attempts**: Max 3 conflicts, then 60s backoff
- **Media**: Max 16MB per file

### API Rate Limits

- **General**: 100 requests/minute per IP
- **Feed fetching**: 10 requests/minute per feed
- **Queue processing**: No explicit limit

---

## Security

### CORS Origins

Set `CORS_ORIGINS` env var:
```
CORS_ORIGINS=https://yourdomain.com,https://app.yourdomain.com
```

### Basic Auth

Enable password protection:
```
BASIC_AUTH_USER=admin
BASIC_AUTH_PASS=your-secure-password
```

All API requests will require:
```
Authorization: Basic YWRtaW46c2VjcmV0
```

---

## Troubleshooting Checklist

**WhatsApp won't connect**:
- [ ] Check auth_state table has lease columns
- [ ] Check only one instance is running
- [ ] Try clearing auth_state and reconnecting
- [ ] Check WhatsApp mobile app is online

**Messages not sending**:
- [ ] WhatsApp connected?
- [ ] Targets configured?
- [ ] Templates exist?
- [ ] Schedules enabled?
- [ ] Not rate limited?

**Feeds not fetching**:
- [ ] Feed URL accessible publicly?
- [ ] Valid RSS/Atom format?
- [ ] Not rate limited?
- [ ] SSL certificate valid?

**Duplicate messages**:
- [ ] Check dedupe indexes exist
- [ ] Verify feed_items table has proper constraints
- [ ] Check message_logs for duplicates

---

## Contact & Resources

**Code**: https://github.com/yourusername/whatsapp-news-bot  
**Render Dashboard**: https://dashboard.render.com  
**Supabase Dashboard**: https://supabase.com/dashboard  
**Baileys Docs**: https://github.com/WhiskeySockets/Baileys

**Emergency Commands**:
```bash
# Restart service
# Go to Render Dashboard → Manual Deploy

# Check logs
# Go to Render Dashboard → Logs tab

# Force disconnect WhatsApp
curl -X POST https://whatsapp-news-bot-3-69qh.onrender.com/api/whatsapp/disconnect
```
