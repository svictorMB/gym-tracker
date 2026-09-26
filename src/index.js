// Gym Tracker — Cloudflare Worker + Supabase
// Identity: Supabase Auth magic links (the browser talks to Supabase Auth directly with the anon key).
// Data: Supabase Postgres via PostgREST, accessed only from this Worker with the service role key.
// Config: SUPABASE_URL and SUPABASE_ANON_KEY as vars, SUPABASE_SERVICE_KEY as a secret.

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

// Logs saved before accounts existed are attached to whoever signs in with these emails,
// and these three are made buddies with each other automatically.
const LEGACY = {
  "samueldavidson@gmail.com": "Sam",
  "selvakumar.victor@gmail.com": "Selva",
  "g.ebenezer.thomas@gmail.com": "Ebe",
};

const PALETTE = ["#1F4FD8", "#D9772B", "#1E8E55", "#8E44AD", "#C2185B", "#00838F", "#6D4C41", "#455A64"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await api(request, env, url); }
      catch (e) { return json({ error: "Server error: " + (e && e.message ? e.message : e) }, 500); }
    }
    const cfg = JSON.stringify({ url: env.SUPABASE_URL || "", anonKey: env.SUPABASE_ANON_KEY || "" }).replace(/</g, "\\u003c");
    return new Response(HTML.replace("__SB_CONFIG__", cfg), { headers: { "content-type": "text/html; charset=utf-8" } });
  },
};

// ---------- helpers ----------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

const pub = p => ({ id: p.id, username: p.username, name: p.name, color: PALETTE[Number(p.seq || 0) % PALETTE.length] });
const q = encodeURIComponent;

// PostgREST call with the service role key.
async function sb(env, path, opts = {}) {
  const method = opts.method || "GET";
  const headers = { apikey: env.SUPABASE_SERVICE_KEY, authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, "content-type": "application/json" };
  if (opts.prefer) headers.prefer = opts.prefer; else if (method !== "GET") headers.prefer = "return=representation";
  const r = await fetch(env.SUPABASE_URL + "/rest/v1/" + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await r.text();
  if (!r.ok) throw new Error("Supabase " + r.status + ": " + text.slice(0, 300));
  return text ? JSON.parse(text) : null;
}

// Validates the browser's Supabase access token and loads the profile.
async function currentUser(request, env) {
  const auth = request.headers.get("authorization") || "";
  if (!/^Bearer \S+$/.test(auth)) return null;
  const r = await fetch(env.SUPABASE_URL + "/auth/v1/user", { headers: { apikey: env.SUPABASE_ANON_KEY, authorization: auth } });
  if (!r.ok) return null;
  const u = await r.json();
  if (!u || !u.id) return null;
  const rows = await sb(env, "profiles?id=eq." + u.id + "&select=id,seq,email,username,name");
  return { id: u.id, email: String(u.email || "").toLowerCase(), profile: rows[0] || null };
}

async function friendsOf(env, uid) {
  const rows = await sb(env, "friendships?or=(requester_id.eq." + uid + ",addressee_id.eq." + uid + ")" +
    "&select=id,status,requester_id,addressee_id,requester:profiles!friendships_requester_id_fkey(id,seq,username,name),addressee:profiles!friendships_addressee_id_fkey(id,seq,username,name)");
  const accepted = [], incoming = [], outgoing = [];
  for (const f of rows) {
    const other = f.requester_id === uid ? f.addressee : f.requester;
    if (!other) continue;
    const item = { fid: f.id, ...pub(other) };
    if (f.status === "accepted") accepted.push(item);
    else if (f.addressee_id === uid) incoming.push(item);
    else outgoing.push(item);
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  return { accepted: accepted.sort(byName), incoming: incoming.sort(byName), outgoing: outgoing.sort(byName) };
}

// ---------- API ----------

async function api(request, env, url) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_KEY) return json({ error: "Supabase isn't configured on the server yet" }, 500);
  const path = url.pathname.slice(5);
  const method = request.method;
  if (method === "POST" && !(request.headers.get("content-type") || "").includes("application/json")) return json({ error: "Expected JSON" }, 415);
  const body = async () => { try { return await request.json(); } catch { return {}; } };

  const me = await currentUser(request, env);
  if (method === "GET" && path === "me") return json({ user: me ? { id: me.id, email: me.email } : null, profile: me && me.profile ? pub(me.profile) : null });
  if (!me) return json({ error: "Please sign in" }, 401);

  // --- first-time profile ---
  if (method === "POST" && path === "profile") {
    if (me.profile) return json({ error: "Profile already set up" }, 409);
    const b = await body();
    const username = String(b.username || "").trim().toLowerCase().replace(/^@/, "");
    const name = String(b.name || "").trim();
    if (!/^[a-z0-9_]{3,20}$/.test(username)) return json({ error: "Username: 3–20 letters, numbers or underscores" }, 400);
    if (!name || name.length > 30) return json({ error: "Enter a display name (up to 30 characters)" }, 400);
    const taken = await sb(env, "profiles?username=eq." + q(username) + "&select=id");
    if (taken.length) return json({ error: "That username is taken" }, 409);
    const [prof] = await sb(env, "profiles", { method: "POST", body: { id: me.id, email: me.email, username, name } });
    const legacyName = LEGACY[me.email];
    if (legacyName) {
      await sb(env, "lifts?user_id=is.null&person=eq." + q(legacyName), { method: "PATCH", body: { user_id: me.id }, prefer: "return=minimal" });
      await sb(env, "weights?user_id=is.null&person=eq." + q(legacyName), { method: "PATCH", body: { user_id: me.id }, prefer: "return=minimal" });
      const crew = Object.keys(LEGACY).filter(e => e !== me.email);
      const others = await sb(env, "profiles?email=in." + q("(" + crew.map(e => '"' + e + '"').join(",") + ")") + "&select=id");
      if (others.length) {
        await sb(env, "friendships?on_conflict=requester_id,addressee_id", {
          method: "POST", prefer: "return=minimal,resolution=ignore-duplicates",
          body: others.map(o => ({ requester_id: me.id, addressee_id: o.id, status: "accepted" })),
        });
      }
    }
    return json({ ok: true, profile: pub(prof) });
  }
  if (!me.profile) return json({ error: "Finish setting up your profile first" }, 403);

  const friends = await friendsOf(env, me.id);
  const circle = [pub(me.profile), ...friends.accepted.map(({ fid, ...u }) => u)];
  const ids = circle.map(u => u.id);
  const inIds = "in.(" + ids.join(",") + ")";
  const nameOf = uid => (circle.find(u => u.id === uid) || {}).name;

  // --- data ---
  if (method === "GET" && path === "data") {
    const [weights, lifts] = await Promise.all([
      sb(env, "weights?user_id=" + inIds + "&select=id,user_id,date,lbs&order=date.asc,id.asc"),
      sb(env, "lifts?user_id=" + inIds + "&select=id,user_id,date,workout,exercise,weight,reps&order=date.desc,id.desc"),
    ]);
    return json({ user: pub(me.profile), people: circle, friends, workouts: WORKOUTS, cues: CUES, weights, lifts });
  }

  if (method === "POST" && path === "weight") {
    const b = await body();
    const uid = String(b.for || me.id);
    if (!ids.includes(uid)) return json({ error: "You can only log for yourself or a buddy" }, 403);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || "")) || !(b.lbs > 0)) return json({ error: "Need a date and a weight" }, 400);
    await sb(env, "weights", { method: "POST", body: { user_id: uid, person: nameOf(uid), date: b.date, lbs: Number(b.lbs) }, prefer: "return=minimal" });
    return json({ ok: true });
  }

  if (method === "POST" && path === "lifts") {
    const b = await body();
    const uid = String(b.for || me.id);
    if (!ids.includes(uid)) return json({ error: "You can only log for yourself or a buddy" }, 403);
    const raw = Array.isArray(b.sets) ? b.sets : [];
    const sets = raw.filter(x => x && (String(x.weight ?? "").trim() !== "" || String(x.reps ?? "").trim() !== ""))
                    .map(x => ({ weight: Number(x.weight), reps: Number(x.reps) }));
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || "")) && WORKOUTS[b.workout]?.includes(b.exercise)
      && sets.length > 0 && sets.every(x => x.weight >= 0 && Number.isInteger(x.reps) && x.reps > 0);
    if (!valid) return json({ error: "Need a date, exercise and at least one set with weight and reps" }, 400);
    await sb(env, "lifts?user_id=eq." + uid + "&date=eq." + b.date + "&exercise=eq." + q(b.exercise), { method: "DELETE", prefer: "return=minimal" });
    await sb(env, "lifts", { method: "POST", prefer: "return=minimal",
      body: sets.map(x => ({ user_id: uid, person: nameOf(uid), date: b.date, workout: b.workout, exercise: b.exercise, weight: x.weight, reps: x.reps })) });
    return json({ ok: true, saved: sets.length });
  }

  if (method === "DELETE" && (path === "weight" || path === "lift")) {
    const rowIds = (url.searchParams.get("ids") || url.searchParams.get("id") || "").split(",").map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (!rowIds.length) return json({ error: "Missing id" }, 400);
    const table = path === "weight" ? "weights" : "lifts";
    await sb(env, table + "?id=in.(" + rowIds.join(",") + ")&user_id=" + inIds, { method: "DELETE", prefer: "return=minimal" });
    return json({ ok: true });
  }

  // --- buddies ---
  if (method === "POST" && path === "friends/request") {
    const b = await body();
    const username = String(b.username || "").trim().toLowerCase().replace(/^@/, "");
    if (!/^[a-z0-9_]{3,20}$/.test(username)) return json({ error: "Enter a username" }, 400);
    const [other] = await sb(env, "profiles?username=eq." + q(username) + "&select=id,seq,username,name");
    if (!other) return json({ error: "No one with that username yet. Ask them to sign in and set up their profile first." }, 404);
    if (other.id === me.id) return json({ error: "That's you" }, 400);
    const [existing] = await sb(env, "friendships?or=(and(requester_id.eq." + me.id + ",addressee_id.eq." + other.id + "),and(requester_id.eq." + other.id + ",addressee_id.eq." + me.id + "))&select=id,status,requester_id");
    if (existing) {
      if (existing.status === "accepted") return json({ error: other.name + " is already your buddy" }, 409);
      if (existing.requester_id === me.id) return json({ error: "Request already sent. Waiting for " + other.name + " to accept." }, 409);
      await sb(env, "friendships?id=eq." + existing.id, { method: "PATCH", body: { status: "accepted" }, prefer: "return=minimal" });
      return json({ ok: true, message: other.name + " had already asked you, so you're buddies now." });
    }
    await sb(env, "friendships", { method: "POST", body: { requester_id: me.id, addressee_id: other.id, status: "pending" }, prefer: "return=minimal" });
    return json({ ok: true, message: "Request sent to " + other.name + "." });
  }

  if (method === "POST" && path === "friends/accept") {
    const b = await body();
    const rows = await sb(env, "friendships?id=eq." + Number(b.id) + "&addressee_id=eq." + me.id + "&status=eq.pending", { method: "PATCH", body: { status: "accepted" } });
    if (!rows.length) return json({ error: "Request not found" }, 404);
    return json({ ok: true });
  }

  if (method === "POST" && path === "friends/remove") {
    const b = await body();
    await sb(env, "friendships?id=eq." + Number(b.id) + "&or=(requester_id.eq." + me.id + ",addressee_id.eq." + me.id + ")", { method: "DELETE", prefer: "return=minimal" });
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
  .msg.ok{color:var(--pb)}
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
  .seg{display:flex;gap:6px}
  .seg button{flex:1;padding:10px 0;border:2px solid var(--line);border-radius:10px;background:var(--panel);color:var(--ink);font-size:16px;font-weight:600;cursor:pointer}
  .seg button[aria-pressed=true]{border-color:var(--accent);color:var(--accent)}
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
  .tabbar{position:sticky;top:0;z-index:5;display:flex;gap:4px;margin:12px -16px 4px;padding:8px 16px 0;background:var(--bg);border-bottom:1px solid var(--line)}
  .tabbar button{flex:1;padding:10px 2px 9px;border:0;border-bottom:3px solid transparent;background:none;color:var(--muted);font-size:15px;font-weight:600;cursor:pointer;white-space:nowrap}
  .tabbar button[aria-selected=true]{color:var(--accent);border-bottom-color:var(--accent)}
  section.tab>h2:first-child{margin-top:16px}
  [hidden]{display:none !important}
</style>
</head>
<body>
<main>
  <div class="top"><h1>Gym Tracker</h1><div class="me" id="me" hidden><span id="mename"></span><button class="link" id="logout" type="button">Log out</button></div></div>
  <p class="sub">Log weigh-ins and your sets. Buddies see each other's progress.</p>

  <section class="panel" id="auth" hidden>
    <form id="linkf">
      <label for="email">Email</label><input id="email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" required>
      <button class="save" type="submit" id="linkbtn">Email me a login link</button>
      <div class="msg" id="linkmsg">No password needed. We'll send a link that signs you in on this device.</div>
    </form>
  </section>

  <section class="panel" id="setup" hidden>
    <h2 style="margin:0 0 4px">Almost there</h2>
    <p class="sub" style="margin-bottom:10px">Pick how you'll appear to your buddies. Signed in as <strong id="setupemail"></strong>.</p>
    <form id="setupf">
      <div class="row" style="margin-top:0">
        <div><label for="rn">Your name</label><input id="rn" maxlength="30" autocomplete="name" required></div>
        <div><label for="ru">Username</label><input id="ru" autocomplete="username" autocapitalize="none" pattern="[A-Za-z0-9_]{3,20}" title="3–20 letters, numbers or underscores" required></div>
      </div>
      <button class="save" type="submit">Save profile</button>
      <div class="msg" id="setupmsg"></div>
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

    <nav class="tabbar" id="tabbar" aria-label="Sections">
      <button type="button" data-tab="workout" role="tab">Workout</button>
      <button type="button" data-tab="weigh" role="tab">Weigh in</button>
      <button type="button" data-tab="bests" role="tab">Bests</button>
      <button type="button" data-tab="recent" role="tab">Recent</button>
    </nav>

    <section class="tab" data-tab="workout">
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
    </section>

    <section class="tab" data-tab="weigh" hidden>
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
    </section>

    <section class="tab" data-tab="bests" hidden>
    <h2>Personal bests</h2>
    <div class="panel wrap" id="pbs"></div>
    </section>

    <section class="tab" data-tab="recent" hidden>
    <h2>Recent sets</h2>
    <div class="panel wrap" id="recent"></div>
    </section>
  </div>
</main>

<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
<script>
(() => {
  const SB = __SB_CONFIG__;
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let data = null, me = null, person = null, savedPersonId = null;
  let workout = "A", step = 0, firstLoad = true;

  const today = new Date().toISOString().slice(0, 10);
  $("ldate").value = today; $("wdate").value = today;
  try {
    savedPersonId = localStorage.getItem("gt_person") || null;
    if (["A", "B"].includes(localStorage.getItem("gt_workout"))) workout = localStorage.getItem("gt_workout");
    const s = localStorage.getItem("gt_step") || "";
    if (s.startsWith(today + ":")) step = Number(s.slice(today.length + 1)) || 0;
  } catch {}

  if (!SB.url || !SB.anonKey || !window.supabase) {
    document.querySelector("main").insertAdjacentHTML("afterbegin", '<p class="msg err">Sign-in isn\\'t configured yet. Add the Supabase settings to the Worker and redeploy.</p>');
    return;
  }
  // Implicit flow so the emailed link works even when it opens in a different browser than the one that requested it.
  const supa = window.supabase.createClient(SB.url, SB.anonKey, { auth: { flowType: "implicit", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });

  // ----- tabs -----
  let tab = "workout";
  try { const t = localStorage.getItem("gt_tab"); if (["workout", "weigh", "bests", "recent"].includes(t)) tab = t; } catch {}
  function showTab(t) {
    tab = t;
    [...document.querySelectorAll("section.tab")].forEach(sec => sec.hidden = sec.dataset.tab !== t);
    [...$("tabbar").children].forEach(b => b.setAttribute("aria-selected", b.dataset.tab === t));
    try { localStorage.setItem("gt_tab", t); } catch {}
  }
  [...$("tabbar").children].forEach(b => b.onclick = () => showTab(b.dataset.tab));
  showTab(tab);

  // ----- screens -----
  function show(which) {
    $("auth").hidden = which !== "auth"; $("setup").hidden = which !== "setup"; $("app").hidden = which !== "app";
    $("me").hidden = which === "auth";
    if (which !== "app") { data = null; }
  }

  async function token() { const { data: d } = await supa.auth.getSession(); return d && d.session ? d.session.access_token : null; }
  async function api(path, opts = {}) {
    const t = await token(); if (!t) { show("auth"); throw new Error("Please sign in"); }
    const headers = { authorization: "Bearer " + t, ...(opts.body ? { "content-type": "application/json" } : {}) };
    const r = await fetch("/api/" + path, { method: opts.method || "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined, cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { show("auth"); throw new Error("Please sign in again"); }
    if (!r.ok) throw new Error(j.error || "Request failed");
    return j;
  }
  const post = (path, body) => api(path, { method: "POST", body: body || {} });

  $("linkf").onsubmit = async e => {
    e.preventDefault(); const m = $("linkmsg"); m.className = "msg"; m.textContent = "Sending…"; $("linkbtn").disabled = true;
    const email = $("email").value.trim().toLowerCase();
    const { error } = await supa.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + "/" } });
    $("linkbtn").disabled = false;
    if (error) { m.className = "msg err"; m.textContent = error.message; return; }
    m.className = "msg ok"; m.textContent = "Link sent to " + email + ". Open it on this device to sign in. Check spam if it doesn't arrive within a minute.";
  };

  $("setupf").onsubmit = async e => {
    e.preventDefault(); const m = $("setupmsg"); m.className = "msg"; m.textContent = "Saving…";
    try { await post("profile", { name: $("rn").value, username: $("ru").value }); m.textContent = ""; firstLoad = true; await boot(); }
    catch (err) { m.className = "msg err"; m.textContent = err.message; }
  };

  $("logout").onclick = async () => { try { await supa.auth.signOut(); } catch {} show("auth"); };

  async function boot() {
    const t = await token();
    if (!t) { show("auth"); return; }
    let who;
    try { who = await api("me"); } catch { return; }
    if (!who.user) { show("auth"); return; }
    if (!who.profile) { $("setupemail").textContent = who.user.email; $("mename").textContent = who.user.email; show("setup"); return; }
    await load();
  }

  supa.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_IN" || event === "INITIAL_SESSION") { if (!data) boot(); }
    if (event === "SIGNED_OUT") show("auth");
  });

  // ----- data -----
  const people = () => data.people;
  const byId = id => people().find(u => u.id === id);

  async function load() {
    data = await api("data"); me = data.user;
    person = byId(person ? person.id : savedPersonId) || people()[0];
    show("app");
    $("mename").textContent = me.name + " · @" + me.username;
    renderWho(); renderBuddies(); renderChart(); renderPBs(); renderRecent();
    if (firstLoad) { firstLoad = false; go(step); } else renderFlow();
  }

  function renderWho() {
    $("who").innerHTML = people().map(u => '<button type="button" data-id="' + u.id + '" style="--p:' + u.color + '" aria-pressed="' + (u.id === person.id) + '">' + esc(u.name) + "</button>").join("");
    [...$("who").children].forEach(b => b.onclick = () => {
      person = byId(b.dataset.id);
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
    h += "<h3>Your buddies</h3>" + (f.accepted.length ? f.accepted.map(u => brow(u, '<button class="mini" type="button" data-a="remove" data-id="' + u.fid + '">Remove</button>')).join("") : '<p class="empty">No buddies yet. Once they have signed in and set up a profile, send a request with their username below.</p>');
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
    if (step < EX().length && tab === "workout") $("entry").scrollIntoView({ block: "nearest", behavior: "smooth" });
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
    try { await api(kind + "?ids=" + ids, { method: "DELETE" }); await load(); } catch (e) { alert(e.message); }
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

  boot().catch(() => { document.querySelector("main").insertAdjacentHTML("afterbegin", '<p class="msg err">Could not reach the server. Try again in a moment.</p>'); });
})();
</script>
</body>
</html>`;
