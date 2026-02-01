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

## Tech Stack
- **Backend**: Express, Baileys (@whiskeysockets/baileys), Supabase (Postgres), node-cron
- **Frontend**: React, shadcn/ui, TanStack Query, react-hook-form + zod
- **Hosting**: Render (with keep-alive endpoint)

## Project Structure
```
├── server/          # Express API + Baileys WhatsApp client
│   ├── src/
│   │   ├── routes/      # API endpoints
│   │   ├── models/      # Supabase-backed data access
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
   ./scripts/npm-safe.sh install
   ```

2. **Configure environment**:
   ```bash
   cp .env.example server/.env
   # Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
   ```

3. **Initialize Supabase schema**:
   - Run the SQL in `supabase/schema.sql` in the Supabase SQL editor to create the `documents` table and indexes.

4. **Start development servers**:
   ```bash
   # Terminal 1 - Backend (port 5000)
   ./scripts/npm-safe.sh run dev:server
   
   # Terminal 2 - Frontend (port 5173)
   ./scripts/npm-safe.sh run dev:client
   ```

5. **Open the app**: http://localhost:5173

## Render Deployment

### Option 1: Using render.yaml (Recommended)
1. Push to GitHub
2. Connect repo to Render
3. Render will auto-detect `render.yaml` and configure the service
4. Set environment variables in Render dashboard:
   - `SUPABASE_URL` - Supabase project URL (pre-filled in `render.yaml`)
   - `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role key (server-only; never expose in client)
   - `BASE_URL` - Your Render app URL (e.g., https://your-app.onrender.com)
   - `KEEP_ALIVE_URL` - Same as BASE_URL + /ping

### Option 2: Manual Setup
1. Create a **Web Service** on Render
2. **Build Command**: `npm install && npm run build:client`
3. **Start Command**: `npm run start:server`
4. Set environment variables (see `.env.example`)

### Required Environment Variables for Production
| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-only) |
| `BASE_URL` | Your Render app URL |
| `KEEP_ALIVE` | Enable keep-alive pings |
| `KEEP_ALIVE_URL` | Ping endpoint URL |

## API Endpoints
- `GET /health` - Health check
- `GET /ping` - Keep-alive endpoint
- `GET /api/whatsapp/status` - Connection status
- `GET /api/whatsapp/qr` - QR code for auth
- `GET /api/whatsapp/groups` - List WhatsApp groups
- `GET /api/whatsapp/channels` - List WhatsApp channels
- Full CRUD for `/api/feeds`, `/api/templates`, `/api/targets`, `/api/schedules`, `/api/settings`, `/api/logs`

## Notes
- WhatsApp auth uses QR displayed in the UI (not terminal)
- All settings are stored in Supabase and editable via UI
- Free tier Render instances spin down after inactivity - use keep-alive
- Session data is stored in Supabase, survives redeploys
