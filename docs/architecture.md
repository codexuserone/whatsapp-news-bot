# WhatsApp News Bot - Architecture

## Overview

A production-ready WhatsApp bot that fetches RSS/Atom feeds and sends formatted news messages to WhatsApp groups and channels. Built with Express + TypeScript backend, Next.js frontend, and Supabase PostgreSQL database.

## System Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Next.js UI    │────▶│  Express API     │────▶│  Supabase DB    │
│   (Port 3000)   │     │  (Port 10000)    │     │  (Postgres)     │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                │
                                ▼
                       ┌──────────────────┐
                       │  Baileys         │
                       │  WhatsApp Web    │◀────▶ WhatsApp Servers
                       └──────────────────┘
```

## Tech Stack

**Backend**:
- Express.js 4.x with TypeScript
- Baileys (WhatsApp Web library)
- Supabase PostgreSQL
- Zod validation
- Swagger/OpenAPI docs

**Frontend**:
- Next.js 16 (App Router)
- React 18
- TypeScript
- Tailwind CSS
- shadcn/ui components

**Infrastructure**:
- Render (hosting)
- Supabase (database)
- Cron-job.org (scheduling backup)

## Database Schema

### Core Tables

**feeds**: RSS/Atom feed sources
```sql
- id, url, name, description
- health_status, last_fetched_at
- created_at, updated_at
```

**feed_items**: Individual articles/posts
```sql
- id, feed_id, title, link, content
- published_at, scraped_content, media_url
- created_at (with dedupe indexes)
```

**templates**: Message formatting templates
```sql
- id, name, template (with {{variables}})
- is_default, send_images
- created_at, updated_at
```

**targets**: WhatsApp destinations
```sql
- id, name, type (group/channel), remote_jid
- created_at, updated_at
```

**schedules**: Automation rules
```sql
- id, name, feed_id, template_id
- cron_expression, is_active
- last_queued_at (cursor for dedupe)
- created_at, updated_at
```

**message_logs**: Delivery tracking
```sql
- id, schedule_id, feed_item_id, target_id
- status (pending/processing/sent/failed)
- retry_count, sent_at, error_message
- Unique: (schedule_id, feed_item_id, target_id)
```

**auth_state**: WhatsApp session storage
```sql
- id, status, qr_code, last_connected
- lease_owner, lease_expires_at  ← Multi-instance coordination
- created_at, updated_at
```

### Key Features

1. **Deduplication**: Feed items deduped by URL + content hash
2. **Idempotency**: Message logs prevent duplicate sends
3. **Multi-instance**: Lease system prevents WhatsApp conflicts
4. **Rate Limiting**: API and feed fetch limits
5. **SSRF Protection**: Blocks private IP requests

## Backend Structure

```
server/src/
├── api/                    # Route handlers
│   ├── routes.ts          # Route registration
│   ├── feeds.ts           # Feed CRUD
│   ├── templates.ts       # Template CRUD
│   ├── targets.ts         # Target CRUD
│   ├── schedules.ts       # Schedule CRUD
│   ├── logs.ts            # Message logs
│   ├── settings.ts        # App settings
│   └── debug.ts           # Debug endpoints
├── controllers/           # Business logic
├── services/              # Core services
│   ├── feedService.ts    # RSS fetching
│   ├── queueService.ts   # Message queue
│   ├── scheduleService.ts # Cron scheduling
│   └── scraperService.ts # Content scraping
├── whatsapp/             # WhatsApp integration
│   ├── client.ts         # Baileys client
│   └── authStore.ts      # Session management
├── middleware/           # Express middleware
│   ├── errorHandler.ts   # Centralized errors
│   ├── rateLimiter.ts    # Rate limiting
│   └── outboundUrl.ts    # SSRF protection
├── db/                   # Database
│   └── supabase.ts       # Supabase client
└── scripts/              # Utilities
    └── migrate.ts        # DB migrations
```

## Frontend Structure

```
apps/web/
├── app/                   # Next.js App Router
│   ├── (main)/           # Main layout
│   │   ├── feeds/        # Feeds page
│   │   ├── templates/    # Templates page
│   │   ├── targets/      # Targets page
│   │   ├── schedules/    # Schedules page
│   │   ├── queue/        # Queue status
│   │   ├── logs/         # Message logs
│   │   └── whatsapp/     # Connection status
│   └── api/              # API routes (if any)
├── src/
│   ├── components/       # Shared UI
│   ├── lib/              # Utilities
│   └── hooks/            # React hooks
└── components/ui/        # shadcn components
```

client/src/               # Legacy Vite app (being migrated)
├── pages/                # React pages
├── components/           # React components
└── ...

## Multi-Instance Coordination

**Problem**: Render runs multiple instances during deploys, causing WhatsApp session conflicts.

**Solution**: Database-backed lease system

1. Each instance tries to acquire lease before connecting
2. Lease has TTL (time-to-live) of 2 minutes
3. Active instance renews lease every 30 seconds
4. If instance dies, lease expires and another takes over
5. Max 3 conflict attempts, then exponential backoff

**Lease Algorithm**:
```typescript
// Try to acquire lease
const lease = await db.query(
  "UPDATE auth_state SET lease_owner = $1, lease_expires_at = NOW() + INTERVAL '2 minutes' WHERE lease_expires_at < NOW() OR lease_owner = $1 RETURNING *"
);

if (lease) {
  // Acquired, start WhatsApp connection
  startConnection();
  // Renew lease every 30s
} else {
  // Another instance holds lease, wait
  backoffAndRetry();
}
```

## Message Flow

```
1. Schedule triggers (cron or manual)
   │
2. Fetch feed items since last_queued_at
   │
3. For each new item:
   │   - Check if already in message_logs
   │   - Apply template formatting
   │   - Insert into message_logs (pending)
   │
4. Queue processor picks up pending items
   │
5. Send via WhatsApp (with image if configured)
   │
6. Update message_logs status → 'sent' or 'failed'
```

## Security Features

1. **CORS**: Origin allowlist via `CORS_ORIGINS`
2. **Basic Auth**: Optional password protection
3. **Rate Limiting**: 
   - API: 100 req/min
   - Feeds: 10 req/min per URL
4. **SSRF Protection**: Blocks private IPs (10.x, 172.x, 192.x)
5. **Input Validation**: Zod schemas for all endpoints
6. **SQL Injection**: Parameterized queries only

## Deployment

### Render (Production)

**Service**: Web Service  
**Build Command**: `npm install && npm run build`  
**Start Command**: `npm start`  
**Health Check**: `/health`

**Environment Variables**:
```
DATABASE_URL=postgresql://...
SUPABASE_URL=https://...
SUPABASE_KEY=...
CORS_ORIGINS=https://yourdomain.com
BASIC_AUTH_USER=admin
BASIC_AUTH_PASS=secret
```

### Database Migrations

```bash
# Run all pending migrations
npm run db:migrate

# Migrations live in: scripts/*.sql
# Applied migrations tracked in: schema_migrations table
```

## Development

### Local Setup

```bash
# 1. Clone and install
git clone <repo>
cd whatsapp-news-bot
npm install

# 2. Set up environment
cp .env.example .env
# Edit .env with your Supabase credentials

# 3. Run migrations
npm run db:migrate

# 4. Start development
npm run dev          # Starts both frontend and backend
```

### Project Commands

```bash
# Backend only
cd server
npm run dev          # Development with hot reload
npm run build        # Compile TypeScript
npm run typecheck    # Type checking
npm run migrate      # Run DB migrations

# Frontend only
cd apps/web
npm run dev          # Next.js dev server
npm run build        # Production build

# Root commands
npm run db:migrate   # Run migrations
npm run typecheck    # Check all TypeScript
```

## Monitoring

**Health Endpoint**: `GET /health`
```json
{
  "status": "healthy",
  "timestamp": "2026-02-05T...",
  "uptime": 12345
}
```

**Debug Endpoints**:
- `GET /api/debug/queue` - Queue status
- `GET /api/debug/leases` - Instance lease status
- `GET /api/whatsapp/status` - WhatsApp connection status

**Logs**: Available in Render dashboard

## Troubleshooting

See [ops-runbook.md](./ops-runbook.md) for detailed troubleshooting.

Quick fixes:

**Instances fighting**: Run `npm run db:migrate`

**WhatsApp disconnected**: Clear auth_state, reconnect via UI

**Messages not sending**: Check targets, templates, schedules are configured

**Feeds erroring**: Check URL is public, SSL valid, not rate limited

## Future Improvements

- [ ] Migrate Vite frontend completely to Next.js
- [ ] Add proper test suite (unit + integration)
- [ ] Implement feed auto-discovery
- [ ] Add message scheduling (delay send)
- [ ] Multi-language template support
- [ ] Feed categorization/tags
- [ ] Advanced filtering (regex, keywords)
- [ ] Message analytics dashboard
- [ ] Webhook notifications for errors
- [ ] Import/export configuration

## License

MIT
