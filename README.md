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
- **Backend**: Express, Baileys (@whiskeysockets/baileys), MongoDB, node-cron
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
   npm install
   ```

2. **Configure environment** (optional - uses in-memory DB by default):
   ```bash
   cp .env.example server/.env
   # Edit server/.env if you want to use MongoDB Atlas
   ```

3. **Start development servers**:
   ```bash
   # Terminal 1 - Backend (port 5000)
   npm run dev:server
   
   # Terminal 2 - Frontend (port 5173)
   npm run dev:client
   ```

4. **Open the app**: http://localhost:5173

## Render Deployment

### Option 1: Using render.yaml (Recommended)
1. Push to GitHub
2. Connect repo to Render
3. Render will auto-detect `render.yaml` and configure the service
4. Set environment variables in Render dashboard:
   - `MONGO_URI` - MongoDB Atlas connection string
   - `BASE_URL` - Your Render app URL (e.g., https://your-app.onrender.com)
   - `KEEP_ALIVE_URL` - Same as BASE_URL + /ping

### Option 2: Manual Setup
1. Create a **Web Service** on Render
2. **Build Command**: `npm install && npm run build:client`
3. **Start Command**: `npm run start:server`
4. Set environment variables (see `.env.example`)

### Required Environment Variables for Production
| Variable | Description | Example |
|----------|-------------|---------|
| `MONGO_URI` | MongoDB connection string | `mongodb+srv://user:pass@cluster.mongodb.net/wabot` |
| `BASE_URL` | Your Render app URL | `https://your-app.onrender.com` |
| `KEEP_ALIVE` | Enable keep-alive pings | `true` |
| `KEEP_ALIVE_URL` | Ping endpoint URL | `https://your-app.onrender.com/ping` |
| `USE_IN_MEMORY_DB` | Must be `false` in production | `false` |

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
- All settings are stored in MongoDB and editable via UI
- Free tier Render instances spin down after inactivity - use keep-alive
- Session data is stored in MongoDB, survives redeploys
