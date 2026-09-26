// One-off: copy lifts and weights from the old Cloudflare D1 database into Supabase.
// Reads SUPABASE_URL / SUPABASE_SERVICE_KEY from .dev.vars (or the environment).
// Rows are inserted with user_id NULL and attach to accounts when people set up their profile.
// Usage: node scripts/migrate-from-d1.mjs [--dry-run]
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

const dry = process.argv.includes("--dry-run");
const env = { ...process.env };
if (existsSync(".dev.vars")) {
  for (const line of readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) { console.error("Need SUPABASE_URL and SUPABASE_SERVICE_KEY in .dev.vars or the environment"); process.exit(1); }

const D1_ACCOUNT = "8e2129b11a7145938453143ccd3f1ec8", D1_ID = "1f58662c-18fc-458e-8bed-6c8ef7b45832";
function cfToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const cfg = join(process.env.APPDATA || "", "xdg.config", ".wrangler", "config", "default.toml");
  const m = existsSync(cfg) && readFileSync(cfg, "utf8").match(/^oauth_token\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error("Run npx wrangler login first (or set CLOUDFLARE_API_TOKEN)");
  return m[1];
}
async function d1(sql) {
  const r = await fetch("https://api.cloudflare.com/client/v4/accounts/" + D1_ACCOUNT + "/d1/database/" + D1_ID + "/query", {
    method: "POST", headers: { authorization: "Bearer " + cfToken(), "content-type": "application/json" }, body: JSON.stringify({ sql }) });
  const j = await r.json();
  if (!j.success) throw new Error("D1: " + JSON.stringify(j.errors));
  return j.result[0].results;
}
async function sb(path, opts = {}) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    method: opts.method || "GET",
    headers: { apikey: SUPABASE_SERVICE_KEY, authorization: "Bearer " + SUPABASE_SERVICE_KEY, "content-type": "application/json", prefer: opts.prefer || "return=minimal" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error("Supabase " + r.status + ": " + text.slice(0, 300));
  return text ? JSON.parse(text) : null;
}

const lifts = await d1("SELECT person, date, workout, exercise, weight, reps, created_at FROM lifts ORDER BY id");
const weights = await d1("SELECT person, date, lbs, created_at FROM weights ORDER BY id");
console.log("D1 has", lifts.length, "lifts and", weights.length, "weigh-ins");

const already = (await sb("lifts?select=id", { prefer: "" })).length + (await sb("weights?select=id", { prefer: "" })).length;
if (already) { console.error("Supabase already has", already, "rows; refusing to import twice. Empty the tables first if you really want to re-run."); process.exit(1); }
if (dry) { console.log("Dry run: nothing written."); process.exit(0); }

const iso = t => t.replace(" ", "T") + "Z";
await sb("lifts", { method: "POST", body: lifts.map(l => ({ person: l.person, date: l.date, workout: l.workout, exercise: l.exercise, weight: l.weight, reps: l.reps, created_at: iso(l.created_at) })) });
await sb("weights", { method: "POST", body: weights.map(w => ({ person: w.person, date: w.date, lbs: w.lbs, created_at: iso(w.created_at) })) });
console.log("Imported", lifts.length, "lifts and", weights.length, "weigh-ins into Supabase (user_id NULL until profiles are created).");
