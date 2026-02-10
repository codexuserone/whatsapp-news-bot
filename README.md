# WhatsApp News Bot

Production-ready WhatsApp bot that fetches RSS/Atom feeds and sends formatted news messages to WhatsApp groups and channels. Built with Express + TypeScript backend, Next.js frontend, and Supabase PostgreSQL database.

## Features
- **WhatsApp Connection** - QR code authentication, multi-instance coordination, auto-recovery
- **Feed Management** - RSS/Atom/JSON feed fetching with deduplication and content scraping
- **Message Templates** - Dynamic templates with variables, image support, markdown formatting
- **Scheduling** - Cron-based automation with queue processing and retry logic
- **Multi-Instance Safety** - Database-backed lease system prevents WhatsApp conflicts
- **Deduplication** - URL + content hash deduplication to prevent duplicate messages
- **Security** - Rate limiting, SSRF protection, CORS allowlist, Basic Auth
- **Monitoring** - Health checks, debug endpoints, comprehensive logging

## Tech Stack
- **Backend**: Express.js 4.x, TypeScript, Baileys (WhatsApp Web), Supabase PostgreSQL
- **Frontend**: Next.js 16 (App Router), React 18, Tailwind CSS, shadcn/ui
- **Infrastructure**: Render hosting, Supabase database, cron-job.org for backup

## Project Structure
```
├── server/                    # Express API + WhatsApp client
│   ├── src/
│   │   ├── api/              # Route handlers and registration
│   │   ├── controllers/      # Business logic
│   │   ├── services/         # Core services (feed, queue, whatsapp)
│   │   ├── whatsapp/         # Baileys integration
│   │   ├── middleware/       # Express middleware (security, validation)
│   │   ├── db/              # Supabase client
│   │   └── scripts/         # Migration scripts
│   └── package.json
├── apps/web/                 # Next.js 16 frontend (new)
│   ├── app/                 # App Router pages
│   ├── src/
│   │   ├── components/      # Shared UI
│   │   └── lib/             # Utilities and API client
│   └── package.json
├── client/                   # Legacy Vite React app (being migrated)
├── scripts/                  # Utility scripts
├── docs/                     # Documentation
│   ├── architecture.md       # System architecture
│   ├── ops-runbook.md       # Operations guide
│   └── migration-checklist.md # Database migration guide
└── render.yaml              # Render deployment config
```

## Quick Start

### 1. Install & Setup
```bash
# Clone and install dependencies
git clone <repository>
cd whatsapp-news-bot
npm run setup

# Configure environment
cp server/.env.example server/.env
# Edit server/.env with your Supabase credentials
```

### 2. Database Setup
```bash
# Run database migrations
npm run db:migrate

# Verify migrations applied
npm run db:check
```

### 3. Development
```bash
# Start development (backend + frontend)
npm run dev

# Or start individually:
npm run dev:server  # Backend on :10000
npm run dev:web     # Frontend on :3000
```

### 4. Production Deployment
```bash
# Quick deploy (checks migrations, builds, provides instructions)
./scripts/quick-deploy.sh

# Then deploy via Render dashboard
```

## Environment Variables

Required in `server/.env`:
```bash
DATABASE_URL=postgresql://user:pass@host:port/dbname
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-supabase-key
CORS_ORIGINS=https://yourdomain.com
```

Optional (production):
```bash
BASIC_AUTH_USER=admin
BASIC_AUTH_PASS=secure-password
REQUIRE_BASIC_AUTH=true
ACCESS_ALLOWLIST=203.0.113.10
HSTS_MAX_AGE_SECONDS=15552000
SKIP_WHATSAPP_LEASE=false
```
### Environment URLs
- Backend API: `http://localhost:10000` (with Swagger docs at `/api-docs`)
- Next.js App: `http://localhost:3000` (production-like app)
- Legacy Vite App: `http://localhost:5173` (being migrated)

**Note**: Set `NEXT_PUBLIC_API_URL` in `apps/web/.env` or `VITE_API_URL` in `client/.env` if backend runs elsewhere.

## Production Deployment

### Quick Deploy (Recommended)
```bash
./scripts/quick-deploy.sh
```
This script:
1. ✅ Checks database migrations
2. 🔍 Runs type checking
3. 🔨 Builds all packages  
4. 📋 Provides deployment instructions

### Render Deployment

**Required Environment Variables**:
```bash
DATABASE_URL=postgresql://user:pass@host:port/dbname
SUPABASE_URL=https://your-project.supabase.co  
SUPABASE_KEY=your-supabase-key
BASE_URL=https://your-app.onrender.com
```

**Optional Security**:
```bash
BASIC_AUTH_USER=admin
BASIC_AUTH_PASS=secure-password
REQUIRE_BASIC_AUTH=true
ACCESS_ALLOWLIST=203.0.113.10
HSTS_MAX_AGE_SECONDS=15552000
CORS_ORIGINS=https://yourdomain.com,https://app.yourdomain.com
```

When `REQUIRE_BASIC_AUTH=true`, all routes require authentication except health probes:
`/health`, `/ping`, and `/ready`.
Optional `ACCESS_ALLOWLIST` further restricts access by source IP.

**Deploy Steps**:
1. Push to GitHub
2. Connect repo to Render
3. Set environment variables
4. Click "Manual Deploy" to apply changes

### Database Migrations (Critical!)

**Run before first deployment**:
```bash
npm run db:migrate
npm run db:check  # Verify applied
```

**If migrations fail**, see `docs/migration-checklist.md` for manual SQL commands.

## Monitoring & Debugging

**Health Checks**:
```bash
# Service health
curl https://your-app.onrender.com/health

# WhatsApp status  
curl https://your-app.onrender.com/api/whatsapp/status

# Queue status
curl https://your-app.onrender.com/api/debug/queue
```

**Common Issues**:
- **Instance conflicts**: Run `npm run db:migrate` to apply lease system
- **WhatsApp disconnected**: Clear auth_state and reconnect via UI  
- **Messages not sending**: Check targets, templates, schedules are configured
- **Feeds erroring**: Verify URLs are public and have valid SSL

## Documentation

- **Architecture**: `docs/architecture.md` - System design and components
- **Operations**: `docs/ops-runbook.md` - Production troubleshooting guide  
- **Migrations**: `docs/migration-checklist.md` - Database update instructions

## API Documentation

Production app serves OpenAPI/Swagger at:
- **Spec**: `/api/openapi.json`
- **UI**: `/api-docs` 

Key endpoints:
- `/api/feeds` - RSS feed management
- `/api/templates` - Message templates  
- `/api/targets` - WhatsApp destinations
- `/api/schedules` - Automation rules
- `/api/logs` - Message history
- `/api/whatsapp/*` - WhatsApp connection & auth

## Security Features

- **Rate Limiting**: API (100/min) and feed fetch (10/min)
- **CORS Protection**: Origin allowlist via `CORS_ORIGINS`
- **Basic Auth**: Optional password protection
- **SSRF Protection**: Blocks private IP requests
- **Input Validation**: Zod schemas for all endpoints
- **Multi-Instance Safety**: Database-backed lease system prevents conflicts

## Development Workflow

```bash
# Feature development
npm run dev          # Start dev servers
npm run typecheck    # TypeScript checking
npm run db:check     # Verify migrations
npm run build:all    # Production build

# Deployment
./scripts/quick-deploy.sh  # Pre-deploy checks
# Then deploy via Render dashboard
```
