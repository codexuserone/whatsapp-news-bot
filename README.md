# WhatsApp News Bot

Automated WhatsApp news distribution system for Anash.org. Fetches content from RSS/Atom/JSON feeds and publishes to WhatsApp Groups, Channels, and Status with scheduling, throttling, and deduplication.

## Features
- **WhatsApp Connection** - QR code auth displayed in-app, real-time status
- **Targets** - Send to Groups, Channels, and Status broadcasts
- **Feeds** - RSS/Atom/JSON with variable extraction and cleaning rules
- **Templates** - WhatsApp markdown with dynamic variables
- **Schedules** - Immediate, interval, or set times dispatch
- **Deduplication** - Fuzzy title/URL matching + chat history check
- **Throttling** - Configurable inter/intra target delays
- **Retention** - Auto-cleanup of old logs and auth states
- **Analytics** - Bayesian posting windows, fatigue/risk scoring, timeline trends, and audience snapshots

## Tech Stack
- **Backend**: Express, Baileys (@whiskeysockets/baileys), Supabase (Postgres), node-cron, TypeScript
- **Frontend**: React, shadcn/ui, TanStack Query, react-hook-form + zod
- **Hosting**: Render (with keep-alive endpoint)

## Project Structure
```
├── server/          # Express API + Baileys WhatsApp client
│   ├── src/
│   │   ├── routes/      # API endpoints
│   │   ├── models/      # Mongoose schemas
│   │   ├── services/    # Business logic
│   │   └── whatsapp/    # Baileys client wrapper
│   └── public/          # Built frontend (after npm run build:client)
├── client/          # React frontend
│   └── src/
│       ├── pages/       # Route pages
│       ├── components/  # UI components
│       └── lib/         # Utilities
└── render.yaml      # Render deployment config
```

## Local Development

1. **Install dependencies**:
   ```bash
   npm run setup
   ```

2. **Configure environment** (required for full CRUD; WhatsApp auth can run in-memory):
   ```bash
   cp server/.env.example server/.env
   # You can also use a root .env if preferred
   ```

3. **Start development servers**:
    ```bash
    # Terminal 1 - Backend (port 10000 by default)
    npm run dev:server
    
    # Terminal 2 - Frontend (Next.js 16)
    npm run dev:web

    # Optional: legacy Vite client (port 5173)
    npm run dev:client
    ```

   If your backend runs on a different host/port, set `NEXT_PUBLIC_API_URL` in `apps/web/.env`.
   Example: `NEXT_PUBLIC_API_URL=http://localhost:10000`
   If you run the Vite UI (`npm run dev:client`), set `VITE_API_URL` in `client/.env`.
   Example: `VITE_API_URL=http://localhost:10000`

4. **Open the app**: http://localhost:3000

## Database Setup (Supabase)
1. Create a Supabase project and grab your:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - Database connection string (`DATABASE_URL` or `SUPABASE_DB_URL`)
2. Run migrations (from the repo root):
   ```bash
   # Set DATABASE_URL or SUPABASE_DB_URL first
   npm run db:migrate
   ```
   The migration runner tracks applied files in the `schema_migrations` table.
3. Alternatively, run the SQL files in `scripts/` (001-019) using the Supabase SQL editor.

## Render Deployment

### Option 1: Using render.yaml (Single Service, Recommended)
1. Push to GitHub
2. Connect repo to Render
3. Render will auto-detect `render.yaml` and configure one service that runs the API and serves the built UI from `server/public`.
4. Set environment variables in Render dashboard:
   - `SUPABASE_URL` - Supabase project URL
   - `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role key
   - `DATABASE_URL` - Postgres connection string (used for automatic migrations)
   - `BASE_URL` - Your Render app URL (e.g., https://your-app.onrender.com)
   - `KEEP_ALIVE_URL` - Same as BASE_URL + /ping
   - `KEEP_ALIVE` - true
   - `RUN_MIGRATIONS_ON_START` - optional (recommended: run migrations manually in Supabase)
   - `MIGRATIONS_STRICT` - optional (set to true to fail startup if migrations fail)

### Option 2: Manual Setup
1. Create a **Web Service** on Render
2. **Build Command**: `npm install --prefix server && npm install --prefix client && npm run build --prefix client && npm run build --prefix server`
3. **Start Command**: `npm run start:server`
4. Set environment variables (see `.env.example`)

### Required Environment Variables for Production
| Variable | Description | Example |
|----------|-------------|---------|
| `SUPABASE_URL` | Supabase project URL | `https://your-project.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key | `your-service-role-key` |
| `DATABASE_URL` / `SUPABASE_DB_URL` | Postgres connection string (migrations) | `postgresql://...` |
| `BASE_URL` | Your Render app URL | `https://your-app.onrender.com` |
| `KEEP_ALIVE` | Enable keep-alive pings | `true` |
| `KEEP_ALIVE_URL` | Ping endpoint URL | `https://your-app.onrender.com/ping` |

### Recommended Security (Basic Auth)
If you deploy this publicly, set:
- `BASIC_AUTH_USER`
- `BASIC_AUTH_PASS`

This protects both the UI and API with browser Basic Auth (health endpoints remain open).

### Recommended Hardening
- `CORS_ORIGINS` - comma-separated UI origins allowed to call the API (use this if the UI is on a different domain)
- `ALLOW_PRIVATE_URLS` - set to `true` only if you intentionally need internal/private feeds or image URLs (SSRF risk)

## API Endpoints
- `GET /health` - Health check
- `GET /ping` - Keep-alive endpoint
- `GET /ready` - Readiness (DB + WhatsApp)
- `GET /api/openapi.json` - OpenAPI spec
- `GET /api/docs` - Swagger UI
- `GET /api/whatsapp/status` - Connection status
- `GET /api/whatsapp/qr` - QR code for auth
- `GET /api/whatsapp/groups` - List WhatsApp groups
- `GET /api/whatsapp/channels` - List WhatsApp channels
- `GET /api/whatsapp/channels/diagnostics` - Channel discovery diagnostics (methods tried + limitations)
- `POST /api/whatsapp/channels/resolve` - Resolve channel from URL/invite/JID to canonical `@newsletter` JID
- `GET /api/analytics/report` - Full analytics report (windows, recommendations, risks, timeline)
- `GET /api/analytics/overview` - Analytics summary cards
- `GET /api/analytics/windows` - 7x24 slot scores and confidence
- `GET /api/analytics/recommendation` - Best posting windows + cron/batch suggestions
- `GET /api/analytics/schedule-recommendations` - Per-schedule tuning recommendations (current vs suggested cron/batch)
- `POST /api/analytics/schedule-recommendations/:id/apply` - Apply suggested cron/batch timing to a schedule
- `POST /api/analytics/audience/snapshot` - Capture live audience sizes from WhatsApp groups/channels
- Full CRUD for `/api/feeds`, `/api/templates`, `/api/targets`, `/api/schedules`, `/api/settings`, `/api/logs`

## Notes
- WhatsApp auth uses QR displayed in the UI (not terminal)
- Channel auto-discovery is constrained by WhatsApp Web/Baileys APIs; set `WHATSAPP_SYNC_FULL_HISTORY=true` to maximize discovered chats/channels.
- Video media sends support optional `thumbnailUrl` (manual API/UI sends) to avoid gray video tiles on some clients.
- All settings are stored in Supabase and editable via UI
- Free tier Render instances spin down after inactivity. Use an external uptime ping against `/ping` to keep it alive.
- Session data is stored in Supabase when configured; otherwise it resets on restart
- Render single-service deploy serves the Vite UI built from `client/` at `/`
- WhatsApp only allows one active web session per account. If you see a `conflict/replaced` error, log out of other linked devices and/or wait for an old deployment to stop before scanning a new QR.
