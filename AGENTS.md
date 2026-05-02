# AGENTS.md

## Cursor Cloud specific instructions

### Project Overview

HealthPulse Captain is a React/TypeScript SPA (Single Page Application) for smartphone-based health monitoring using camera PPG (photoplethysmography). The UI is entirely in Spanish. It uses Supabase as BaaS (auth, database, edge functions) and Vite as build tool.

### Development Commands

| Task | Command |
|------|---------|
| Dev server | `npm run dev` (Vite on port 8080, binds `::`) |
| Build | `npm run build` |
| Lint | `npx eslint .` |
| Preview | `npm run preview` |

### Key Notes

- **No backend server to run locally** — the app is a pure frontend SPA with Supabase cloud as the backend.
- **Pre-existing lint errors**: The codebase has ~69 ESLint errors (mostly `@typescript-eslint/no-explicit-any` and `no-empty`). These are pre-existing and not blocking.
- **Camera features**: The core PPG measurement feature requires a physical mobile device camera. On desktop/VM, the measurement UI loads but cannot capture real data. The app handles this gracefully.
- **Supabase credentials**: The `.env` file contains a cloud Supabase project anon key. The app has a fallback stub client if Supabase is unreachable, but auth and data persistence require the cloud service.
- **Port 8080**: Vite dev server always binds to port 8080 (configured in `vite.config.ts`).
- **Hot reload**: Vite HMR works correctly. No need to restart the dev server after code changes.
- **Node.js 20+**: Required. The project uses ESLint 9 flat config and modern TypeScript features.
