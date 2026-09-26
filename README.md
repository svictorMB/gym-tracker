# Gym Tracker
Live at https://gym-tracker.ctcapps.workers.dev

Weigh-in and workout tracker with a buddy system. Cloudflare Worker + Supabase (Auth magic links + Postgres).

## How it works
- Enter your email and open the login link it sends. First time in, pick a name and username.
- Open **Buddies**, enter a buddy's username and send a request. They accept from their Buddies panel.
- You and your accepted buddies see each other's weigh-ins, sets and personal bests, and can log sets for each other when sharing a phone at the gym.
- **Today's workout** walks through workout A or B one exercise at a time, prefilling last time's sets.

## Setup
1. In Supabase: run `supabase/schema.sql` in the SQL editor, and add `https://gym-tracker.ctcapps.workers.dev/**` under Authentication → URL Configuration → Redirect URLs.
2. Store the two API keys as Worker secrets (never commit them):
```
npm install
npx wrangler login
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put SUPABASE_SERVICE_KEY
npm run deploy
```

## Local dev
Copy `.dev.vars.example` to `.dev.vars`, fill in both keys, then `npm run dev`.

## Attaching the old logs
Rows imported from the original D1 database have `user_id = NULL` and a `person` name. The `LEGACY` map in `src/index.js` lists the three original emails: when one of them signs in and creates a profile, their old rows attach automatically and they become buddies with the other two. To import the D1 rows once: `node scripts/migrate-from-d1.mjs`.

## Layout
- `src/index.js` – the Worker: serves the page, `/api/*` endpoints, auth and buddies
- `supabase/schema.sql` – Postgres tables
- `scripts/migrate-from-d1.mjs` – one-off import of the old D1 rows
- `wrangler.toml` – Cloudflare config and Supabase URL

## Not included yet
Email change and account deletion happen in the Supabase dashboard (Authentication → Users).
