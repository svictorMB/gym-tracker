// Gym Tracker — Cloudflare Worker + D1
// Binding required: DB -> D1 database "gym-tracker"
// Accounts: email + password (PBKDF2), cookie sessions stored in D1.
// Buddies: friend request + accept. You see (and can log for) yourself and accepted buddies.

const WORKOUTS = {
  A: ["Leg press", "Chest press machine", "Seated cable row", "Dumbbell Romanian deadlift", "Seated shoulder press machine", "Plank (seconds)"],
  B: ["Goblet squat", "Lat pulldown", "Incline dumbbell press", "Seated leg curl", "Cable face pull", "Dead bug (reps per side)"],
};

const CUES = {
  "Leg press": "Feet shoulder-width on the plate. Lower until the knees are near 90°, press back up without locking out.",
  "Chest press machine": "Handles level with mid-chest. Press smoothly and control the return; don't let the stack slam.",
  "Seated cable row": "Sit tall, pull the handle to your stomach and squeeze the shoulder blades together, then return slowly.",
  "Dumbbell Romanian deadlift": "Soft knees, hinge at the hips with a flat back, dumbbells close to the legs, stand up by squeezing the glutes.",
  "Seated shoulder press machine": "Press up without shrugging the shoulders. Stop just short of locking the elbows.",
  "Plank (seconds)": "Straight line from head to heels, squeeze the glutes, keep breathing. Log the seconds held as reps.",
  "Goblet squat": "Hold the dumbbell at your chest, sit down between the knees with the chest up, drive through the heels.",
  "Lat pulldown": "Lean back slightly, pull the bar to the upper chest with the elbows down, control it back up.",
  "Incline dumbbell press": "Bench at about 30°. Lower the dumbbells to chest level, press up and slightly inward.",
  "Seated leg curl": "Pad just above the ankles. Curl all the way, then return slowly without letting the stack drop.",
  "Cable face pull": "Rope at face height. Pull toward the forehead with the elbows high, squeeze the rear shoulders.",
  "Dead bug (reps per side)": "Lower back pressed into the floor. Extend the opposite arm and leg, exhale as you extend, alternate sides.",
};

const PALETTE = ["#1F4FD8", "#D9772B", "#1E8E55", "#8E44AD", "#C2185B", "#00838F", "#6D4C41", "#455A64"];
const SESSION_DAYS = 90;
const PBKDF2_ITERATIONS = 100000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await api(request, env, url); }
      catch (e) { return json({ error: "Server error: " + (e && e.message ? e.message : e) }, 500); }
    }
    return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
};

// ---------- helpers ----------

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
function randomHex(bytes) { const a = new Uint8Array(bytes); crypto.getRandomValues(a); return hex(a); }

async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS }, key, 256);
  return hex(bits);
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function getCookie(request, name) {
  const m = (request.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? m[1] : null;
}

function sessionCookie(id, url, maxAge) {
  return "gt_session=" + id + "; Path=/; HttpOnly; SameSite=Lax" + (url.protocol === "https:" ? "; Secure" : "") + "; Max-Age=" + maxAge;
}

const pub = u => ({ id: u.id, username: u.username, name: u.name, color: PALETTE[u.id % PALETTE.length] });

async function currentUser(request, env) {
  const sid = getCookie(request, "gt_session");
  if (!sid) return null;
  return await env.DB.prepare(
    "SELECT u.id, u.email, u.username, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > datetime('now')"
  ).bind(sid).first();
}

async function startSession(env, user, url) {
  const sid = randomHex(32);
  await env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', ?))")
    .bind(sid, user.id, "+" + SESSION_DAYS + " days").run();
  return json({ ok: true, user: pub(user) }, 200, { "set-cookie": sessionCookie(sid, url, SESSION_DAYS * 86400) });
}

async function friendsOf(env, uid) {
  const r = await env.DB.prepare(
    `SELECT f.id AS fid, f.status, f.requester_id, f.addressee_id, u.id, u.username, u.name
     FROM friendships f
     JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
     WHERE f.requester_id = ? OR f.addressee_id = ?
     ORDER BY u.name COLLATE NOCASE`
  ).bind(uid, uid, uid).all();
  const accepted = [], incoming = [], outgoing = [];
  for (const row of r.results) {
    const item = { fid: row.fid, ...pub(row) };
    if (row.status === "accepted") accepted.push(item);
    else if (row.addressee_id === uid) incoming.push(item);
    else outgoing.push(item);
  }
  return { accepted, incoming, outgoing };
}

// ---------- API ----------

async function api(request, env, url) {
  const path = url.pathname.slice(5);
  const method = request.method;
  if (method === "POST" && !(request.headers.get("content-type") || "").includes("application/json")) {
    return json({ error: "Expected JSON" }, 415);
  }
  const body = async () => { try { return await request.json(); } catch { return {}; } };

  // --- accounts ---
  if (method === "POST" && path === "register") {
    const b = await body();
    const email = String(b.email || "").trim().toLowerCase();
    const username = String(b.username || "").trim().toLowerCase().replace(/^@/, "");
    const name = String(b.name || "").trim();
    const password = String(b.password || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Enter a valid email" }, 400);
    if (!/^[a-z0-9_]{3,20}$/.test(username)) return json({ error: "Username: 3–20 letters, numbers or underscores" }, 400);
    if (!name || name.length > 30) return json({ error: "Enter a display name (up to 30 characters)" }, 400);
    if (password.length < 8) return json({ error: "Password needs at least 8 characters" }, 400);
    const exists = await env.DB.prepare("SELECT id FROM users WHERE email = ? OR username = ?").bind(email, username).first();
    if (exists) return json({ error: "That email or username is already taken" }, 409);
    const salt = randomHex(16);
    const pass_hash = await hashPassword(password, salt);
    const ins = await env.DB.prepare("INSERT INTO users (email, username, name, pass_hash, salt) VALUES (?, ?, ?, ?, ?)")
      .bind(email, username, name, pass_hash, salt).run();
    return startSession(env, { id: ins.meta.last_row_id, email, username, name }, url);
  }

  if (method === "POST" && path === "login") {
    const b = await body();
    const ident = String(b.identity || "").trim().toLowerCase().replace(/^@/, "");
    const password = String(b.password || "");
    const u = await env.DB.prepare("SELECT id, email, username, name, pass_hash, salt FROM users WHERE email = ? OR username = ?").bind(ident, ident).first();
    const attempt = await hashPassword(password, u ? u.salt : randomHex(16));
    if (!u || !safeEqual(attempt, u.pass_hash)) return json({ error: "Wrong email/username or password" }, 401);
    return startSession(env, u, url);
  }

  if (method === "POST" && path === "logout") {
    const sid = getCookie(request, "gt_session");
    if (sid) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sid).run();
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", url, 0) });
  }

  const me = await currentUser(request, env);
  if (method === "GET" && path === "me") return json({ user: me ? pub(me) : null });
  if (!me) return json({ error: "Please sign in" }, 401);

  const friends = await friendsOf(env, me.id);
  const circle = [pub(me), ...friends.accepted.map(({ fid, ...u }) => u)];
  const ids = circle.map(u => u.id);
  const placeholders = ids.map(() => "?").join(",");
  const nameOf = uid => (circle.find(u => u.id === uid) || {}).name;

  // --- data ---
  if (method === "GET" && path === "data") {
    const [weights, lifts] = await Promise.all([
      env.DB.prepare(`SELECT id, user_id, date, lbs FROM weights WHERE user_id IN (${placeholders}) ORDER BY date ASC, id ASC`).bind(...ids).all(),
      env.DB.prepare(`SELECT id, user_id, date, workout, exercise, weight, reps FROM lifts WHERE user_id IN (${placeholders}) ORDER BY date DESC, id DESC`).bind(...ids).all(),
    ]);
    return json({ user: pub(me), people: circle, friends, workouts: WORKOUTS, cues: CUES, weights: weights.results, lifts: lifts.results });
  }

  if (method === "POST" && path === "weight") {
    const b = await body();
    const uid = Number(b.for || me.id);
    if (!ids.includes(uid)) return json({ error: "You can only log for yourself or a buddy" }, 403);
    if (!b.date || !(b.lbs > 0)) return json({ error: "Need a date and a weight" }, 400);
    await env.DB.prepare("INSERT INTO weights (user_id, person, date, lbs) VALUES (?, ?, ?, ?)").bind(uid, nameOf(uid), b.date, b.lbs).run();
    return json({ ok: true });
  }

  if (method === "POST" && path === "lifts") {
    const b = await body();
    const uid = Number(b.for || me.id);
    if (!ids.includes(uid)) return json({ error: "You can only log for yourself or a buddy" }, 403);
    const raw = Array.isArray(b.sets) ? b.sets : [];
    const sets = raw.filter(x => x && (String(x.weight ?? "").trim() !== "" || String(x.reps ?? "").trim() !== ""))
                    .map(x => ({ weight: Number(x.weight), reps: Number(x.reps) }));
    const valid = b.date && WORKOUTS[b.workout]?.includes(b.exercise) && sets.length > 0 && sets.every(x => x.weight >= 0 && x.reps > 0);
    if (!valid) return json({ error: "Need a date, exercise and at least one set with weight and reps" }, 400);
    const stmt = env.DB.prepare("INSERT INTO lifts (user_id, person, date, workout, exercise, weight, reps) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const clear = env.DB.prepare("DELETE FROM lifts WHERE user_id = ? AND date = ? AND exercise = ?").bind(uid, b.date, b.exercise);
    await env.DB.batch([clear, ...sets.map(x => stmt.bind(uid, nameOf(uid), b.date, b.workout, b.exercise, x.weight, x.reps))]);
    return json({ ok: true, saved: sets.length });
  }

  if (method === "DELETE" && (path === "weight" || path === "lift")) {
    const rowIds = (url.searchParams.get("ids") || url.searchParams.get("id") || "").split(",").map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (!rowIds.length) return json({ error: "Missing id" }, 400);
    const table = path === "weight" ? "weights" : "lifts";
    await env.DB.prepare(`DELETE FROM ${table} WHERE id IN (${rowIds.map(() => "?").join(",")}) AND user_id IN (${placeholders})`).bind(...rowIds, ...ids).run();
    return json({ ok: true });
  }

  // --- buddies ---
  if (method === "POST" && path === "friends/request") {
    const b = await body();
    const username = String(b.username || "").trim().toLowerCase().replace(/^@/, "");
    if (!username) return json({ error: "Enter a username" }, 400);
    const other = await env.DB.prepare("SELECT id, username, name FROM users WHERE username = ?").bind(username).first();
    if (!other) return json({ error: "No one with that username yet. Ask them to register first." }, 404);
    if (other.id === me.id) return json({ error: "That's you" }, 400);
    const existing = await env.DB.prepare(
      "SELECT id, status, requester_id FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)"
    ).bind(me.id, other.id, other.id, me.id).first();
    if (existing) {
      if (existing.status === "accepted") return json({ error: other.name + " is already your buddy" }, 409);
      if (existing.requester_id === me.id) return json({ error: "Request already sent. Waiting for " + other.name + " to accept." }, 409);
      await env.DB.prepare("UPDATE friendships SET status = 'accepted' WHERE id = ?").bind(existing.id).run();
      return json({ ok: true, message: other.name + " had already asked you, so you're buddies now." });
    }
    await env.DB.prepare("INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?, ?, 'pending')").bind(me.id, other.id).run();
    return json({ ok: true, message: "Request sent to " + other.name + "." });
  }

  if (method === "POST" && path === "friends/accept") {
    const b = await body();
    const r = await env.DB.prepare("UPDATE friendships SET status = 'accepted' WHERE id = ? AND addressee_id = ? AND status = 'pending'").bind(Number(b.id), me.id).run();
    if (!r.meta.changes) return json({ error: "Request not found" }, 404);
    return json({ ok: true });
  }

  if (method === "POST" && path === "friends/remove") {
    const b = await body();
    await env.DB.prepare("DELETE FROM friendships WHERE id = ? AND (requester_id = ? OR addressee_id = ?)").bind(Number(b.id), me.id, me.id).run();
    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
}

// ---------- page ----------

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Gym Tracker</title>
<style>
  :root{
    --bg:#EEF2F1; --panel:#FFFFFF; --ink:#17232A; --muted:#66757C; --line:#D5DDDB;
    --accent:#1F4FD8; --accent-ink:#fff; --pb:#1E8E55; --danger:#B3261E;
    box-sizing:border-box;
  }
  @media (prefers-color-scheme: dark){
    :root{ --bg:#101A1E; --panel:#182428; --ink:#EEF2F1; --muted:#9AAAB0; --line:#2B3A40; --pb:#4CC287; --accent:#6C8CFF; }
  }
  *,*:before,*:after{box-sizing:inherit}
  html{scroll-padding-top:env(safe-area-inset-top,0px)}
  body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}
  main{max-width:640px;margin:0 auto;padding:20px 16px 48px}
  .top{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
  h1{font-size:28px;margin:8px 0 2px;letter-spacing:-.01em}
  .me{font-size:14px;color:var(--muted);white-space:nowrap}
  .link{background:none;border:0;color:var(--accent);cursor:pointer;font-size:14px;padding:0;margin-left:8px}
  .sub{color:var(--muted);margin:0 0 18px}
  h2{font-size:17px;margin:28px 0 10px}
  h3{font-size:13px;color:var(--muted);margin:12px 0 2px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
  .who{display:flex;gap:8px;margin-bottom:6px;flex-wrap:wrap}
  .who button{flex:1;min-width:90px;padding:12px 0;border:2px solid var(--line);background:var(--panel);color:var(--ink);border-radius:12px;font-size:17px;font-weight:600;cursor:pointer}
  .who button[aria-pressed=true]{border-color:var(--p);color:var(--p)}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px}
  .row{display:flex;gap:8px;margin-top:10px}
  .row>*{flex:1;min-width:0}
  label{display:block;font-size:13px;color:var(--muted);margin-bottom:4px}
  .mt{margin-top:10px}
  input,select{width:100%;padding:11px 10px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);font-size:16px}
  input:focus,select:focus,button:focus-visible{outline:3px solid var(--accent);outline-offset:1px}
  .save{width:100%;margin-top:12px;padding:13px;border:0;border-radius:10px;background:var(--accent);color:var(--accent-ink);font-size:16px;font-weight:600;cursor:pointer}
  .save:disabled{opacity:.6}
  .msg{min-height:20px;font-size:14px;margin-top:8px;color:var(--muted)}
  .msg.pb{color:var(--pb);font-weight:600}
  .msg.err{color:var(--danger)}
  table{width:100%;border-collapse:collapse;font-size:15px}
  th{font-weight:600;color:var(--muted);text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);font-size:13px}
  td{padding:9px 6px;border-bottom:1px solid var(--line);vertical-align:top}
  td.n{white-space:nowrap}
  .wrap{overflow-x:auto}
  .chip{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:middle}
  .del{background:none;border:0;color:var(--muted);font-size:13px;cursor:pointer;padding:0}
  .empty{color:var(--muted);font-size:15px;margin:6px 0}
  svg{width:100%;height:auto;display:block}
  .legend{display:flex;gap:14px;font-size:14px;margin-top:6px;color:var(--muted);flex-wrap:wrap}
  .tabs,.seg{display:flex;gap:6px}
  .tabs{margin-bottom:12px}
  .tabs button,.seg button{flex:1;padding:10px 0;border:2px solid var(--line);border-radius:10px;background:var(--panel);color:var(--ink);font-size:16px;font-weight:600;cursor:pointer}
  .tabs button[aria-pressed=true],.seg button[aria-pressed=true]{border-color:var(--accent);color:var(--accent)}
  .inline{display:flex;gap:8px;margin:12px 0 0}
  .inline input{flex:1}
  .inline button,.mini{padding:0 14px;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--ink);cursor:pointer;font-size:14px}
  .mini{padding:6px 10px;border-radius:8px;font-size:13px;margin-left:6px}
  .mini.go{border-color:var(--pb);color:var(--pb)}
  details.buddies{margin:8px 0 0}
  details.buddies summary{cursor:pointer;color:var(--muted);font-size:14px;padding:6px 0;list-style-position:inside}
  details.buddies .panel{margin-top:6px}
  .brow{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--line);font-size:15px}
  .brow:last-child{border-bottom:0}
  .brow .nm{flex:1;min-width:0}
  .brow small{color:var(--muted)}
  .acts{flex:none;white-space:nowrap}
  .sets{display:grid;gap:8px;margin-top:12px}
  .set{display:grid;grid-template-columns:52px 1fr 1fr;gap:8px;align-items:center}
  .set .setn,.set label{font-size:13px;color:var(--muted);margin:0}
  .hint{font-size:13px;color:var(--muted);margin:8px 0 0}
  .steps{list-style:none;margin:14px 0 0;padding:0;display:grid;gap:6px}
  .steps button{width:100%;display:flex;align-items:center;gap:10px;padding:9px 10px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);font-size:15px;text-align:left;cursor:pointer}
  .steps .active button{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
  .tick{flex:none;width:24px;height:24px;border-radius:50%;border:1px solid var(--line);display:grid;place-items:center;font-size:12px;font-weight:600;color:var(--muted)}
  .steps .done .tick{background:var(--pb);border-color:var(--pb);color:#fff}
  .nm{flex:1;min-width:0}
  .steps .nm small{display:block;color:var(--muted);font-size:12px}
  .whos{flex:none}
  .whos .chip{margin:0 0 0 3px}
  .current{margin-top:14px;padding-top:14px;border-top:1px solid var(--line)}
  .stepn{font-size:13px;color:var(--muted)}
  .exname{font-size:20px;font-weight:700;margin:2px 0 4px}
  .cue{font-size:14px;color:var(--muted);margin:0 0 6px}
  .last{font-size:14px;margin:0}
  .nav{display:flex;gap:8px;margin-top:10px}
  .nav button{flex:1;padding:11px;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--ink);font-size:15px;cursor:pointer}
  .nav button:disabled{opacity:.4}
  .finished{margin-top:14px;padding:14px;border-radius:10px;background:var(--bg);font-size:15px}
  [hidden]{display:none !important}
</style>
</head>
<body>
<main>
  <div class="top"><h1>Gym Tracker</h1><div class="me" id="me" hidden><span id="mename"></span><button class="link" id="logout" type="button">Log out</button></div></div>
  <p class="sub">Log weigh-ins and your sets. Buddies see each other's progress.</p>

  <section class="panel" id="auth" hidden>
    <div class="tabs"><button type="button" data-t="login" aria-pressed="true">Log in</button><button type="button" data-t="register" aria-pressed="false">Register</button></div>
    <form id="loginf">
      <label for="li">Email or username</label><input id="li" autocomplete="username" required>
      <label class="mt" for="lp">Password</label><input id="lp" type="password" autocomplete="current-password" required>
      <button class="save" type="submit">Log in</button>
      <div class="msg" id="loginmsg"></div>
    </form>
    <form id="regf" hidden>
      <div class="row" style="margin-top:0">
        <div><label for="rn">Your name</label><input id="rn" maxlength="30" autocomplete="name" required></div>
        <div><label for="ru">Username</label><input id="ru" autocomplete="username" autocapitalize="none" pattern="[A-Za-z0-9_]{3,20}" title="3–20 letters, numbers or underscores" required></div>
      </div>
      <label class="mt" for="re">Email</label><input id="re" type="email" autocomplete="email" required>
      <label class="mt" for="rp">Password (8+ characters)</label><input id="rp" type="password" autocomplete="new-password" minlength="8" required>
      <button class="save" type="submit">Create account</button>
      <div class="msg" id="regmsg"></div>
    </form>
  </section>

  <div id="app" hidden>
    <div class="who" id="who"></div>
    <details class="buddies" id="buddies">
      <summary id="bsum">Buddies</summary>
      <div class="panel">
        <div id="blist"></div>
        <form class="inline" id="addf"><input id="addu" placeholder="Buddy's username" autocomplete="off" autocapitalize="none"><button type="submit">Send request</button></form>
        <div class="msg" id="bmsg"></div>
      </div>
    </details>

    <h2>Today's workout</h2>
    <div class="panel">
      <div class="row" style="margin-top:0">
        <div><label for="ldate">Date</label><input id="ldate" type="date"></div>
        <div><label>Workout</label><div class="seg" id="wsel"><button type="button" data-w="A">A</button><button type="button" data-w="B">B</button></div></div>
      </div>
      <ol class="steps" id="steps" aria-label="Exercises in this workout"></ol>
      <div class="current" id="entry">
        <div class="stepn" id="stepn"></div>
        <div class="exname" id="exname"></div>
        <p class="cue" id="cue"></p>
        <p class="last" id="last"></p>
        <div class="sets" id="sets">
          <div class="set"><span></span><label>Weight (lbs)</label><label>Reps or seconds</label></div>
          <div class="set"><span class="setn">Set 1</span><input class="sw" type="number" inputmode="decimal" min="0" step="2.5" aria-label="Set 1 weight"><input class="sr" type="number" inputmode="numeric" min="1" aria-label="Set 1 reps"></div>
          <div class="set"><span class="setn">Set 2</span><input class="sw" type="number" inputmode="decimal" min="0" step="2.5" aria-label="Set 2 weight"><input class="sr" type="number" inputmode="numeric" min="1" aria-label="Set 2 reps"></div>
          <div class="set"><span class="setn">Set 3</span><input class="sw" type="number" inputmode="decimal" min="0" step="2.5" aria-label="Set 3 weight"><input class="sr" type="number" inputmode="numeric" min="1" aria-label="Set 3 reps"></div>
        </div>
        <p class="hint">Use 0 lbs for bodyweight. Leave a set blank to skip it. Rows prefill from last time. After saving, tap the next person: their own last numbers load if they have any, otherwise yours carry over. Saving again replaces that person's sets for this exercise today.</p>
        <button class="save" id="liftsave" type="button">Save sets</button>
        <div class="msg" id="liftmsg"></div>
        <div class="nav"><button type="button" id="prev">← Back</button><button type="button" id="next">Next exercise →</button></div>
      </div>
      <div class="finished" id="finished" hidden></div>
    </div>

    <h2>Weigh in</h2>
    <div class="panel">
      <div class="row" style="margin-top:0">
        <div><label for="wdate">Date</label><input id="wdate" type="date"></div>
        <div><label for="wlbs">Weight (lbs)</label><input id="wlbs" type="number" inputmode="decimal" min="50" step="0.1"></div>
      </div>
      <button class="save" id="wsave" type="button">Save weigh-in</button>
      <div class="msg" id="wmsg"></div>
    </div>

    <h2>Weight over time</h2>
    <div class="panel" id="chart"><p class="empty">No weigh-ins yet. The chart appears after the first one.</p></div>

    <h2>Personal bests</h2>
    <div class="panel wrap" id="pbs"></div>

    <h2>Recent sets</h2>
    <div class="panel wrap" id="recent"></div>
  </div>
</main>

<script>
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let data = null, me = null, person = null, savedPersonId = null;
  let workout = "A", step = 0, firstLoad = true;

  const today = new Date().toISOString().slice(0, 10);
  $("ldate").value = today; $("wdate").value = today;
  try {
    savedPersonId = Number(localStorage.getItem("gt_person")) || null;
    if (["A", "B"].includes(localStorage.getItem("gt_workout"))) workout = localStorage.getItem("gt_workout");
    const s = localStorage.getItem("gt_step") || "";
    if (s.startsWith(today + ":")) step = Number(s.slice(today.length + 1)) || 0;
  } catch {}

  // ----- auth -----
  function showAuth() { $("auth").hidden = false; $("app").hidden = true; $("me").hidden = true; data = null; me = null; }
  function showApp() { $("auth").hidden = true; $("app").hidden = false; $("me").hidden = false; }

  [...document.querySelectorAll(".tabs button")].forEach(b => b.onclick = () => {
    [...document.querySelectorAll(".tabs button")].forEach(x => x.setAttribute("aria-pressed", x === b));
    $("loginf").hidden = b.dataset.t !== "login"; $("regf").hidden = b.dataset.t !== "register";
  });

  async function post(path, body) {
    const r = await fetch("/api/" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && path !== "login") { showAuth(); throw new Error("Please sign in again"); }
    if (!r.ok) throw new Error(j.error || "Request failed");
    return j;
  }

  $("loginf").onsubmit = async e => {
    e.preventDefault(); const m = $("loginmsg"); m.className = "msg"; m.textContent = "Signing in…";
    try { await post("login", { identity: $("li").value, password: $("lp").value }); $("lp").value = ""; m.textContent = ""; firstLoad = true; await load(); }
    catch (err) { m.className = "msg err"; m.textContent = err.message; }
  };
  $("regf").onsubmit = async e => {
    e.preventDefault(); const m = $("regmsg"); m.className = "msg"; m.textContent = "Creating your account…";
    try { await post("register", { name: $("rn").value, username: $("ru").value, email: $("re").value, password: $("rp").value }); $("rp").value = ""; m.textContent = ""; firstLoad = true; await load(); }
    catch (err) { m.className = "msg err"; m.textContent = err.message; }
  };
  $("logout").onclick = async () => { try { await post("logout"); } catch {} showAuth(); };

  // ----- data -----
  const people = () => data.people;
  const byId = id => people().find(u => u.id === id);
  const colorOf = id => (byId(id) || {}).color || "var(--muted)";

  async function load() {
    const r = await fetch("/api/data", { cache: "no-store" });
    if (r.status === 401) { showAuth(); return; }
    if (!r.ok) throw new Error("load failed");
    data = await r.json(); me = data.user;
    person = byId(person ? person.id : savedPersonId) || people()[0];
    showApp();
    $("mename").textContent = me.name + " · @" + me.username;
    renderWho(); renderBuddies(); renderChart(); renderPBs(); renderRecent();
    if (firstLoad) { firstLoad = false; go(step); } else renderFlow();
  }

  function renderWho() {
    $("who").innerHTML = people().map(u => '<button type="button" data-id="' + u.id + '" style="--p:' + u.color + '" aria-pressed="' + (u.id === person.id) + '">' + esc(u.name) + "</button>").join("");
    [...$("who").children].forEach(b => b.onclick = () => {
      person = byId(Number(b.dataset.id));
      try { localStorage.setItem("gt_person", person.id); } catch {}
      $("liftmsg").className = "msg"; $("liftmsg").textContent = "";
      renderWho();
      const ex = EX()[step];
      if (ex && (setsToday(person, ex).length || lastTime(person, ex))) fillFromHistory();
      renderFlow();
    });
  }

  // ----- buddies -----
  const brow = (u, actions) => '<div class="brow"><i class="chip" style="background:' + u.color + '"></i><span class="nm">' + esc(u.name) + ' <small>@' + esc(u.username) + '</small></span><span class="acts">' + actions + "</span></div>";
  function renderBuddies() {
    const f = data.friends; let h = "";
    if (f.incoming.length) h += "<h3>Requests for you</h3>" + f.incoming.map(u => brow(u, '<button class="mini go" type="button" data-a="accept" data-id="' + u.fid + '">Accept</button><button class="mini" type="button" data-a="remove" data-id="' + u.fid + '">Decline</button>')).join("");
    h += "<h3>Your buddies</h3>" + (f.accepted.length ? f.accepted.map(u => brow(u, '<button class="mini" type="button" data-a="remove" data-id="' + u.fid + '">Remove</button>')).join("") : '<p class="empty">No buddies yet. Once they have registered, send a request with their username below.</p>');
    if (f.outgoing.length) h += "<h3>Waiting on</h3>" + f.outgoing.map(u => brow(u, '<button class="mini" type="button" data-a="remove" data-id="' + u.fid + '">Cancel</button>')).join("");
    $("blist").innerHTML = h;
    const n = f.incoming.length;
    $("bsum").textContent = "Buddies (" + f.accepted.length + ")" + (n ? " · " + n + " request" + (n > 1 ? "s" : "") + " waiting" : "") + " · @" + me.username;
    if (n) $("buddies").open = true;
    [...$("blist").querySelectorAll("button")].forEach(b => b.onclick = async () => {
      const m = $("bmsg"); m.className = "msg"; m.textContent = "";
      try { await post("friends/" + b.dataset.a, { id: Number(b.dataset.id) }); await load(); }
      catch (e) { m.className = "msg err"; m.textContent = e.message; }
    });
  }
  $("addf").onsubmit = async e => {
    e.preventDefault(); const m = $("bmsg"); m.className = "msg"; m.textContent = "Sending…";
    try { const r = await post("friends/request", { username: $("addu").value }); $("addu").value = ""; await load(); m.textContent = r.message || "Request sent."; }
    catch (err) { m.className = "msg err"; m.textContent = err.message; }
  };

  // ----- guided workout -----
  const EX = () => data.workouts[workout];
  const fmt = ss => ss.map(x => x.weight + "×" + x.reps).join(", ");
  function setsToday(p, ex) { const d = $("ldate").value; return data.lifts.filter(l => l.user_id === p.id && l.exercise === ex && l.date === d).sort((a, b) => a.id - b.id); }
  function lastTime(p, ex) {
    const d = $("ldate").value, prior = data.lifts.filter(l => l.user_id === p.id && l.exercise === ex && l.date < d);
    if (!prior.length) return null;
    const date = prior[0].date;
    return { date, sets: prior.filter(l => l.date === date).sort((a, b) => a.id - b.id) };
  }
  function remember() { try { localStorage.setItem("gt_workout", workout); localStorage.setItem("gt_step", today + ":" + step); } catch {} }
  const setRows = () => [...document.querySelectorAll("#sets .set")].filter(r => r.querySelector(".sw"));

  function fillFromHistory() {
    const ex = EX()[step]; if (!ex) return;
    const mine = setsToday(person, ex), lt = lastTime(person, ex);
    const src = mine.length ? mine : (lt ? lt.sets : []);
    setRows().forEach((r, i) => { r.querySelector(".sw").value = src[i] ? src[i].weight : ""; r.querySelector(".sr").value = src[i] ? src[i].reps : ""; });
  }

  function go(i) {
    step = Math.max(0, Math.min(i, EX().length));
    fillFromHistory();
    $("liftmsg").className = "msg"; $("liftmsg").textContent = "";
    renderFlow();
    if (step < EX().length) $("entry").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function renderFlow() {
    [...$("wsel").children].forEach(b => b.setAttribute("aria-pressed", b.dataset.w === workout));
    const ex = EX(), n = ex.length;
    if (step > n) step = n;
    $("steps").innerHTML = ex.map((e, i) => {
      const mine = setsToday(person, e);
      const who = people().filter(p => setsToday(p, e).length).map(p => '<i class="chip" style="background:' + p.color + '" title="' + esc(p.name) + '"></i>').join("");
      return '<li class="' + (i === step ? "active" : "") + (mine.length ? " done" : "") + '"><button type="button" data-i="' + i + '" aria-current="' + (i === step) + '"><span class="tick">' + (mine.length ? "✓" : i + 1) + '</span><span class="nm">' + e + (mine.length ? "<small>" + fmt(mine) + "</small>" : "") + '</span><span class="whos">' + who + "</span></button></li>";
    }).join("");
    [...$("steps").querySelectorAll("button")].forEach(b => b.onclick = () => go(Number(b.dataset.i)));
    const done = step >= n;
    $("entry").hidden = done; $("finished").hidden = !done;
    if (done) {
      const count = ex.filter(e => setsToday(person, e).length).length;
      $("finished").innerHTML = "<strong>Workout " + workout + " done.</strong> " + esc(person.name) + " logged " + count + " of " + n + " exercises today. Tap any exercise above to add or fix sets.";
    } else {
      $("stepn").textContent = "Exercise " + (step + 1) + " of " + n;
      $("exname").textContent = ex[step];
      $("cue").textContent = (data.cues || {})[ex[step]] || "";
      const lt = lastTime(person, ex[step]), mine = setsToday(person, ex[step]);
      $("last").textContent = mine.length ? person.name + " today: " + fmt(mine) : lt ? person.name + " last time (" + lt.date + "): " + fmt(lt.sets) : "First time logging this one for " + person.name + ".";
      $("next").textContent = step === n - 1 ? "Finish workout ✓" : "Next exercise →";
      $("prev").disabled = step === 0;
    }
    remember();
  }
  [...$("wsel").children].forEach(b => b.onclick = () => { if (workout !== b.dataset.w) { workout = b.dataset.w; go(0); } });
  $("next").onclick = () => go(step + 1);
  $("prev").onclick = () => go(step - 1);
  $("ldate").onchange = () => go(step);

  function bestFor(p, ex) {
    return data.lifts.filter(l => l.user_id === p.id && l.exercise === ex).sort((a, b) => b.weight - a.weight || b.reps - a.reps)[0];
  }

  $("liftsave").onclick = async () => {
    const sets = setRows()
      .map(r => ({ weight: r.querySelector(".sw").value.trim(), reps: r.querySelector(".sr").value.trim() }))
      .filter(x => x.weight !== "" || x.reps !== "");
    const body = { for: person.id, date: $("ldate").value, workout, exercise: EX()[step], sets };
    if (!body.exercise) return;
    const prev = bestFor(person, body.exercise);
    const m = $("liftmsg"); m.className = "msg"; m.textContent = "Saving…"; $("liftsave").disabled = true;
    try {
      const r = await post("lifts", body); await load();
      const isPB = sets.some(x => { const w = Number(x.weight), rp = Number(x.reps); return !prev || w > prev.weight || (w === prev.weight && rp > prev.reps); });
      m.className = isPB ? "msg pb" : "msg";
      m.textContent = (isPB ? "New personal best! " : "") + "Saved " + r.saved + (r.saved === 1 ? " set" : " sets") + " for " + person.name + ". Tap the next person to log theirs, or Next exercise.";
    } catch (e) { m.className = "msg err"; m.textContent = e.message; }
    $("liftsave").disabled = false;
  };

  $("wsave").onclick = async () => {
    const m = $("wmsg"); m.className = "msg"; m.textContent = "Saving…"; $("wsave").disabled = true;
    try { await post("weight", { for: person.id, date: $("wdate").value, lbs: Number($("wlbs").value) }); await load(); m.textContent = "Saved for " + person.name + "."; $("wlbs").value = ""; }
    catch (e) { m.className = "msg err"; m.textContent = e.message; }
    $("wsave").disabled = false;
  };

  async function del(kind, ids, n) {
    if (!confirm(n > 1 ? "Delete these " + n + " sets?" : "Delete this entry?")) return;
    const r = await fetch("/api/" + kind + "?ids=" + ids, { method: "DELETE" });
    if (r.ok) load(); else alert("Could not delete.");
  }
  $("recent").onclick = e => { const b = e.target.closest("button.del"); if (b) del(b.dataset.k, b.dataset.ids, Number(b.dataset.n)); };

  // ----- views -----
  function renderChart() {
    const W = data.weights;
    if (!W.length) { $("chart").innerHTML = '<p class="empty">No weigh-ins yet. The chart appears after the first one.</p>'; return; }
    const dates = [...new Set(W.map(w => w.date))].sort();
    const xs = d => 40 + (dates.length === 1 ? 260 : (dates.indexOf(d) / (dates.length - 1)) * 520);
    const lo = Math.min(...W.map(w => w.lbs)) - 3, hi = Math.max(...W.map(w => w.lbs)) + 3;
    const ys = v => 20 + (1 - (v - lo) / (hi - lo)) * 180;
    let svg = '<svg viewBox="0 0 600 240" role="img" aria-label="Body weight over time">';
    [lo, (lo + hi) / 2, hi].forEach(v => { const y = ys(v); svg += '<line x1="40" x2="580" y1="' + y + '" y2="' + y + '" stroke="var(--line)"/><text x="36" y="' + (y + 4) + '" text-anchor="end" font-size="11" fill="var(--muted)">' + Math.round(v) + "</text>"; });
    people().forEach(p => {
      const pts = W.filter(w => w.user_id === p.id); if (!pts.length) return;
      svg += '<polyline fill="none" stroke="' + p.color + '" stroke-width="2.5" points="' + pts.map(w => xs(w.date) + "," + ys(w.lbs)).join(" ") + '"/>';
      pts.forEach(w => svg += '<circle cx="' + xs(w.date) + '" cy="' + ys(w.lbs) + '" r="4" fill="' + p.color + '"/>');
    });
    svg += '<text x="40" y="232" font-size="11" fill="var(--muted)">' + dates[0] + '</text><text x="580" y="232" text-anchor="end" font-size="11" fill="var(--muted)">' + dates[dates.length - 1] + "</text></svg>";
    svg += '<div class="legend">' + people().map(p => { const last = W.filter(w => w.user_id === p.id).slice(-1)[0]; return '<span><i class="chip" style="background:' + p.color + '"></i>' + esc(p.name) + (last ? " " + last.lbs + " lb" : "") + "</span>"; }).join("") + "</div>";
    $("chart").innerHTML = svg;
  }

  function renderPBs() {
    let h = "<table><tr><th>Exercise</th>" + people().map(p => "<th>" + esc(p.name) + "</th>").join("") + "</tr>";
    for (const w of ["A", "B"]) {
      for (const ex of data.workouts[w]) {
        h += "<tr><td>" + ex + "</td>" + people().map(p => { const b = bestFor(p, ex); return '<td class="n">' + (b ? b.weight + " × " + b.reps : "–") + "</td>"; }).join("") + "</tr>";
      }
    }
    $("pbs").innerHTML = h + "</table>";
  }

  function renderRecent() {
    const groups = [];
    for (const l of data.lifts) {
      const g = groups.find(x => x.d === l.date && x.uid === l.user_id && x.ex === l.exercise);
      if (g) g.sets.push(l); else groups.push({ d: l.date, uid: l.user_id, ex: l.exercise, sets: [l] });
    }
    const L = groups.slice(0, 25), W = data.weights.slice(-10).reverse();
    if (!L.length && !W.length) { $("recent").innerHTML = '<p class="empty">Nothing logged yet.</p>'; return; }
    let h = "<table><tr><th>Date</th><th>Who</th><th>What</th><th></th></tr>";
    const rows = [...L.map(g => { const ss = g.sets.slice().sort((a, b) => a.id - b.id); return { d: g.d, uid: g.uid, t: g.ex + " " + fmt(ss), k: "lift", id: ss[ss.length - 1].id, ids: ss.map(x => x.id).join(","), n: ss.length }; }),
                  ...W.map(w => ({ d: w.date, uid: w.user_id, t: "Weigh-in " + w.lbs + " lb", k: "weight", id: w.id, ids: String(w.id), n: 1 }))].sort((a, b) => b.d.localeCompare(a.d) || b.id - a.id).slice(0, 30);
    rows.forEach(r => { const u = byId(r.uid) || { name: "?", color: "var(--muted)" }; h += '<tr><td class="n">' + r.d + '</td><td class="n"><i class="chip" style="background:' + u.color + '"></i>' + esc(u.name) + "</td><td>" + r.t + '</td><td><button class="del" type="button" data-k="' + r.k + '" data-ids="' + r.ids + '" data-n="' + r.n + '">Delete</button></td></tr>'; });
    $("recent").innerHTML = h + "</table>";
  }

  load().catch(() => { document.querySelector("main").insertAdjacentHTML("afterbegin", '<p class="msg err">Could not reach the server. Try again in a moment.</p>'); });
})();
</script>
</body>
</html>`;
