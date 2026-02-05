# WhatsApp News Bot - Comprehensive System Audit & TODO List

**Date:** 2026-02-05  
**Status:** 🔴 WhatsApp Disconnected, Queue Building Up  
**URL:** https://whatsapp-news-bot-3-69qh.onrender.com

---

## 🚨 CRITICAL ISSUES (Blocking Message Sending)

### 1. WhatsApp Lease System Preventing Connection
**Status:** 🔴 **CRITICAL - Blocking all message sends**
- **Problem:** WhatsApp status shows `disconnected` with error "Could not take over session. Retrying..."
- **Impact:** Cannot connect to WhatsApp, messages queuing but not sending
- **Queue Status:** 8 pending messages waiting
- **Root Cause:** The lease system (migration 011) was added to prevent conflicts during deploys, but it's now preventing ANY connection
- **Evidence:**
  ```
  {"status":"disconnected","lastError":"Could not take over session. Retrying...","lease":{"supported":true,"held":false}}
  ```

**TODO:**
- [ ] **Option A:** Disable lease system entirely for now (quick fix)
- [ ] **Option B:** Fix the forceAcquireLease logic to properly take over expired/null leases
- [ ] [ ] Clear the stuck lease from auth_state table in Supabase
- [ ] [ ] Test WhatsApp connection after fix

### 2. Missing Base Database Migrations
**Status:** 🔴 **CRITICAL - Fresh installs will fail**
- **Problem:** Migrations 013 and 014 exist but reference tables with no creation migrations
- **Missing Migrations:** 001-010 that create core tables (feeds, templates, targets, schedules, etc.)
- **Impact:** New database setup impossible; only works on existing databases
- **Tables Missing Creation Migrations:**
  - auth_state (exists, but constraint migration 014 references it)
  - feeds
  - feed_items
  - templates
  - targets
  - schedules
  - message_logs
  - settings
  - feed_images

**TODO:**
- [ ] Create comprehensive 001_base_schema.sql migration
- [ ] Document existing schema from current database
- [ ] Test migration on fresh Supabase project

---

## 🟡 HIGH PRIORITY ISSUES

### 3. Frontend/Backend Sync Issues
**Status:** 🟡 **HIGH**

#### 3a. Missing `send_images` Field in Templates UI
- **Location:** `server/src/middleware/validation.ts:38-44` vs `client/src/pages/TemplatesPage.jsx`
- **Problem:** Backend expects `send_images: boolean` with default `true`, but UI doesn't expose this option
- **Impact:** Users can't control whether templates send images; always uses default (true)
- **TODO:**
  - [ ] Add "Send Images" toggle to Templates form
  - [ ] Ensure toggle saves/loads correctly

#### 3b. Feature Parity: Web App Missing Feed Refresh
- **Location:** `apps/web/app/(main)/feeds/page.tsx` vs `client/src/pages/FeedsPage.jsx`
- **Problem:** Vite client has refresh feed button, Next.js web app doesn't
- **Impact:** Inconsistent UX between the two frontends
- **TODO:**
  - [ ] Add refresh button to Next.js feeds page
  - [ ] Ensure both apps have same functionality

#### 3c. Undocumented API Endpoints
- **Location:** Various route files vs `server/src/openapi.ts`
- **Problem:** 7 endpoints exist but aren't in OpenAPI spec
- **Missing from spec:**
  - POST /api/feeds/refresh-all
  - POST /api/feeds/{id}/refresh
  - POST /api/schedules/dispatch-all
  - POST /api/schedules/{id}/queue-latest
  - POST /api/queue/reset-processing
  - POST /api/whatsapp/clear-sender-keys
  - POST /api/whatsapp/takeover
- **TODO:**
  - [ ] Add all missing endpoints to openapi.ts
  - [ ] Ensure Swagger UI shows complete API

### 4. Environment Variable Chaos
**Status:** 🟡 **HIGH**

#### 4a. Inconsistent Naming Across Packages
| Package | Variable | Purpose |
|---------|----------|---------|
| server | SUPABASE_URL | Supabase connection |
| server | SUPABASE_SERVICE_ROLE_KEY | Supabase auth |
| client | VITE_API_URL | API base URL |
| web | NEXT_PUBLIC_API_URL | API base URL |
| web | NEXT_PUBLIC_SUPABASE_URL | (unused?) |

- **Problem:** No standardization, confusing which vars belong where
- **TODO:**
  - [ ] Create .env.example files for ALL packages
  - [ ] Document variable purposes in README
  - [ ] Remove unused variables

#### 4b. Root Package.json Pollution
- **Location:** Root `package.json`
- **Problem:** Root has runtime deps (express, baileys) that should only be in server/
- **Impact:** Violates monorepo separation of concerns
- **TODO:**
  - [ ] Audit root package.json
  - [ ] Move runtime deps to appropriate sub-packages
  - [ ] Root should only have dev tools (husky, lint-staged, etc.)

#### 4c. Legacy MongoDB References
- **Location:** `server/src/config/env.ts:20-21`
- **Problem:** Code still references MONGO_URI and USE_IN_MEMORY_DB
- **Impact:** Confusing - implies MongoDB is still supported
- **TODO:**
  - [ ] Remove MongoDB-related env vars from config
  - [ ] Clean up any MongoDB fallback code

---

## 🟢 MEDIUM PRIORITY ISSUES

### 5. Code Quality & Consistency

#### 5a. Client Not Using TypeScript
- **Status:** 🟢 **MEDIUM**
- **Problem:** All client files are .jsx but architecture doc specifies TypeScript
- **Files:** 11 page components, lib files, UI components
- **Impact:** No type safety on frontend, inconsistent DX
- **TODO:**
  - [ ] Migrate client to TypeScript (big effort)
  - [ ] OR deprecate client in favor of apps/web (Next.js already has TS)

#### 5b. Architecture Doc Drift
- **Location:** `docs/architecture.md` vs actual code
- **Problem:** Docs show different structure than implementation
- **Differences:**
  - Docs: `apps/api/` structure → Actual: `server/src/`
  - Docs: "vertical slice modules" → Actual: traditional layered
  - Docs: `modules/` folder → Actual: `routes/` folder
  - Docs: `chat_messages` table → Not found in code
- **TODO:**
  - [ ] Update architecture.md to match actual code
  - [ ] OR refactor code to match architecture (big effort)

#### 5c. Unused Code
- **Location:** `server/src/routes/index.ts`
- **Problem:** Imports `rateLimit` but never uses it
- **TODO:**
  - [ ] Remove unused imports
  - [ ] Audit for other dead code

### 6. Feed Processing Issues

#### 6a. Feed Test Endpoint Doesn't Save Type
- **Location:** `server/src/routes/feeds.ts:34-81`
- **Problem:** Test endpoint detects feed type but doesn't return it in usable format
- **Impact:** Type detection works but isn't integrated properly
- **TODO:**
  - [ ] Standardize feed type detection response
  - [ ] Ensure detected type is shown in UI

#### 6b. Unused refresh-all Endpoint
- **Location:** `server/src/routes/feeds.ts:182-239`
- **Problem:** Endpoint exists but neither frontend uses it
- **TODO:**
  - [ ] Add "Refresh All Feeds" button to UI
  - [ ] OR remove endpoint if not needed

---

## 📊 CURRENT SYSTEM STATE

### WhatsApp Status
```json
{
  "status": "disconnected",
  "lastError": "Could not take over session. Retrying...",
  "lease": {
    "supported": true,
    "held": false,
    "ownerId": null,
    "expiresAt": null
  }
}
```

### Queue Status
```json
{
  "pending": 8,
  "processing": 0,
  "sent": 9,
  "failed": 0,
  "skipped": 0,
  "total": 17
}
```

### Settings
- Message Delay: 2000ms (2 seconds between messages)
- Max Retries: 3
- Inter-target Delay: 8 seconds
- Intra-target Delay: 3 seconds

---

## ✅ IMMEDIATE ACTION PLAN

### Phase 1: Fix WhatsApp Connection (TODAY)
1. **Disable lease system temporarily**
   - Edit `server/src/whatsapp/client.ts`
   - Skip lease acquisition entirely
   - Deploy and test connection

2. **If that works, investigate lease issue**
   - Check Supabase auth_state table
   - Clear stale lease data
   - Re-enable lease system properly

### Phase 2: Fix Database Migrations (THIS WEEK)
1. Create 001_base_schema.sql with all core tables
2. Test on fresh Supabase project
3. Document migration procedure

### Phase 3: Frontend Sync (THIS WEEK)
1. Add send_images toggle to Templates
2. Add refresh button to Next.js feeds
3. Update OpenAPI spec

### Phase 4: Cleanup (NEXT WEEK)
1. Standardize environment variables
2. Remove dead code
3. Update documentation

---

## 🎯 SUCCESS CRITERIA

- [ ] WhatsApp connects successfully
- [ ] Messages send automatically from queue
- [ ] All migrations run cleanly on fresh DB
- [ ] Both frontends (client & web) have feature parity
- [ ] No unused endpoints or dead code
- [ ] Environment variables well-documented

---

## 📋 DETAILED CHECKLIST

### Database & Migrations
- [ ] Create 001_base_schema.sql migration
- [ ] Include all tables: auth_state, feeds, feed_items, templates, targets, schedules, message_logs, settings, feed_images
- [ ] Include all indexes and constraints
- [ ] Test migration on fresh Supabase instance
- [ ] Document how to run migrations

### WhatsApp Connection
- [ ] Fix or disable lease system
- [ ] Test WhatsApp QR code generation
- [ ] Verify connection persists
- [ ] Test message sending
- [ ] Verify queue processes messages

### API & Backend
- [ ] Add missing endpoints to OpenAPI spec
- [ ] Remove unused rateLimit import
- [ ] Remove MongoDB references from env.ts
- [ ] Clean up root package.json
- [ ] Add input validation where missing

### Frontend - Client (Vite)
- [ ] Add send_images toggle to TemplatesPage
- [ ] Create .env.example
- [ ] Fix any TypeScript errors if migrating

### Frontend - Web (Next.js)
- [ ] Add feed refresh button to feeds page
- [ ] Verify all features work
- [ ] Create .env.example

### DevOps & Config
- [ ] Document all environment variables
- [ ] Create deployment runbook
- [ ] Set up proper CI/CD if needed
- [ ] Document troubleshooting steps

### Documentation
- [ ] Update architecture.md
- [ ] Update README.md with current setup
- [ ] Document migration procedure
- [ ] Create troubleshooting guide

---

## 🔍 INVESTIGATION NOTES

### Lease System Investigation
The lease system is storing data but takeover is failing. Possible causes:
1. forceAcquireLease not properly updating database
2. Race condition between old instance and new
3. Database constraint preventing updates
4. Supabase RLS policies blocking updates

**Next Steps:**
- Add detailed logging to forceAcquireLease
- Check Supabase logs for update failures
- Verify RLS policies on auth_state table
- Test direct SQL update to confirm permissions

### Queue Investigation
Queue is building up because:
1. WhatsApp is disconnected (can't send)
2. Feed fetching continues (adds to queue)
3. Schedulers might still be running (adds to queue)

**Once WhatsApp is fixed:**
- Messages should send automatically
- Queue should drain
- Verify rate limiting (2 sec delays) works

---

## 📝 NOTES

**Immediate Fix Priority:**
1. WhatsApp connection (blocking everything)
2. Database migrations (needed for reliability)
3. Frontend sync (improves UX)
4. Cleanup (maintainability)

**Technical Debt:**
- Lease system complexity vs value
- Two frontends to maintain
- Missing type safety in client
- Incomplete migrations

**Architecture Decisions Needed:**
- Keep both frontends or deprecate one?
- Keep lease system or simplify?
- Migrate client to TypeScript or not?
