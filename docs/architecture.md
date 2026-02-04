# Target Architecture Plan

This document captures the target architecture and the defaults I will use for the requested transformation.

## Goals
- Move to strict TypeScript across backend and frontend.
- Use Supabase Postgres as the system of record.
- Keep Express + Baileys for WhatsApp connectivity.
- Migrate UI to Next.js 16 + shadcn/ui with vertical slice organization.
- Add centralized error handling, Zod validation, OpenAPI + Swagger UI.
- Enforce dedupe and idempotent dispatch to avoid double sends.

## Assumptions (defaults)
- "double execution" means duplicate dispatch sends due to retries or overlapping schedules.
- "crppn" means cron scheduling.
- "inc earsky rerurn and small idctions" means refactor to early returns and smaller functions.

## Runtime Topology
- `apps/api`: Express API (TypeScript) running on Node.js.
- `apps/web`: Next.js 16 App Router (TypeScript) for the UI.
- Supabase Postgres for all persistent data including auth state.

Local dev:
- API on `http://localhost:10000`
- Web on `http://localhost:3000`

## Repo Layout (target)
```
apps/
  api/
    src/
      api/               # route registrations, middleware
      modules/           # vertical slices
      core/              # config, logging, error types
      db/                # supabase client + repositories
    package.json
  web/
    app/                 # Next.js App Router
    src/
      modules/           # vertical slices
      components/        # shared UI
      lib/               # api client, utilities
    package.json
docs/
```

## Vertical Slice Modules
Each slice owns its routes, schemas, services, and UI.
- whatsapp
- feeds
- feed-items
- templates
- targets
- schedules
- queue
- logs
- settings
- shabbos

## Backend Layers (per slice)
- `route` -> `controller` -> `service` -> `repository` -> `supabase client`
- Controllers only parse input and map to response DTOs.
- Services handle business logic and orchestrations.
- Repositories isolate Supabase queries and return typed models.

## Centralized Error Handling
- `AppError` base class with status + code.
- Zod validation errors mapped to 400.
- Supabase errors mapped to 400/404/409/500 as appropriate.
- Unified JSON error shape:
  `{ error: { code, message, details? } }`

## Validation and Types
- Zod schemas for request payloads and responses.
- `zod-to-openapi` to generate OpenAPI.
- Strict `tsconfig` with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

## Supabase Schema (high level)
- `feeds`, `feed_items`, `templates`, `targets`, `schedules`, `message_logs`,
  `settings`, `auth_state`, `chat_messages`
- Unique constraints for:
  - feed_items: `(feed_id, normalized_url)` or `(feed_id, content_hash)`
  - message_logs: `(schedule_id, feed_item_id, target_id)`
- Indexes on feed_id, status, created_at, schedule_id, target_id.

## Dedupe Strategy
- Normalize URL and generate deterministic content hash (title + url).
- Fuzzy match by title similarity for near-duplicates.
- Enforce DB-level uniqueness where possible.

## Queue Idempotency
- Insert message_logs with unique keys to prevent duplicate sends.
- Use advisory locks or lease rows on schedule execution.
- Retry safe sends with `retry_count` and backoff.

## WhatsApp Integration
- Baileys service isolated in `whatsapp` module.
- Auth state persisted in `auth_state` table with recovery on corruption.
- Image sending with fallback to text for unsupported targets.

## Scheduling (cron)
- Polling feeds on interval with jitter.
- Cron expression scheduler for dispatch.
- Immediate dispatch path for new items.

## OpenAPI + Swagger UI
- OpenAPI served at `/api/openapi.json`.
- Swagger UI served at `/api/docs`.

## Frontend
- Next.js 16 App Router, strict TS.
- shadcn/ui for components.
- Typed API client with request/response schemas.

## Migration Approach
1) Convert backend to TS + layering + errors + Zod + OpenAPI.
2) Implement Supabase schema + repositories + dedupe + idempotency.
3) Migrate UI to Next.js + vertical slices, then remove Vite app.
