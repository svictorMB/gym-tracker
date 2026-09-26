# Gym Tracker
Live at https://gym-tracker.ctcapps.workers.dev

Weigh-in and workout tracker with accounts and a buddy system. Cloudflare Worker + D1.

## How it works
- Register with a name, username, email and password, then log in.
- Open **Buddies**, enter a buddy's username and send a request. They accept from their Buddies panel.
- You and your accepted buddies see each other's weigh-ins, sets and personal bests, and can log sets for each other when sharing a phone at the gym.
- **Today's workout** walks through workout A or B one exercise at a time, prefilling last time's sets.

## Setup
```
npm install
npx wrangler login
npm run db:migrate          # applies migrations/ to the remote D1 database
npm run deploy
```

## Local dev
```
npm run db:migrate:local
npm run dev
```

## Attaching the old logs
Rows logged before accounts existed have `user_id = NULL` and a `person` name. The `LEGACY` map in `src/index.js` lists the three original emails: when one of them registers, their old rows attach automatically and they become buddies with the other two. For anyone else, attach rows by hand (replace the username and name):
```
npx wrangler d1 execute gym-tracker --remote --command "UPDATE lifts SET user_id = (SELECT id FROM users WHERE username = 'sam') WHERE user_id IS NULL AND person = 'Sam'; UPDATE weights SET user_id = (SELECT id FROM users WHERE username = 'sam') WHERE user_id IS NULL AND person = 'Sam';"
```

## Layout
- `src/index.js` – the Worker: serves the page, `/api/*` endpoints, auth and buddies
- `migrations/` – D1 schema, applied with `wrangler d1 migrations apply`
- `wrangler.toml` – Cloudflare config and D1 binding

## Not included yet
Password reset. If someone forgets their password, delete their row in `users` and have them register again, then re-attach their logs with the command above.
