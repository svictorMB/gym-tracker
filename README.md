# Gym Tracker

Shared weigh-in and personal-best tracker for Sam, Ebe and Selva. Cloudflare Worker + D1.

## Setup
```
npm install
npx wrangler login
npm run deploy
npx wrangler secret put PIN      # optional shared code so only the three of you can log
```
The D1 database `gym-tracker` already exists and has its tables. If you ever recreate it, run `npm run db:init` and update `database_id` in `wrangler.toml`.

## Local dev
```
npm run dev
```
Add `PIN=1234` to a `.dev.vars` file to test the PIN locally.

## Layout
- `src/index.js` – the Worker: serves the page and the `/api/*` endpoints
- `schema.sql` – D1 tables
- `wrangler.toml` – Cloudflare config and D1 binding
