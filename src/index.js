// Gym Tracker — Cloudflare Worker + D1
// Binding required: DB -> D1 database "gym-tracker"
// Optional secret: PIN (a short shared code the three of you type once per device)

const PEOPLE = ["Sam", "Ebe", "Selva"];
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return api(request, env, url);
    return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function authorized(request, env) {
  if (!env.PIN) return true;
  return request.headers.get("x-pin") === env.PIN;
}

async function api(request, env, url) {
  const path = url.pathname.replace("/api/", "");

  if (request.method === "GET" && path === "data") {
    const [weights, lifts] = await Promise.all([
      env.DB.prepare("SELECT id, person, date, lbs FROM weights ORDER BY date ASC, id ASC").all(),
      env.DB.prepare("SELECT id, person, date, workout, exercise, weight, reps FROM lifts ORDER BY date DESC, id DESC").all(),
    ]);
    return json({ people: PEOPLE, workouts: WORKOUTS, cues: CUES, weights: weights.results, lifts: lifts.results, pinRequired: !!env.PIN });
  }

  if (!authorized(request, env)) return json({ error: "Wrong PIN" }, 401);

  if (request.method === "POST" && path === "weight") {
    const b = await request.json();
    if (!PEOPLE.includes(b.person) || !b.date || !(b.lbs > 0)) return json({ error: "Need a name, a date and a weight" }, 400);
    await env.DB.prepare("INSERT INTO weights (person, date, lbs) VALUES (?, ?, ?)").bind(b.person, b.date, b.lbs).run();
    return json({ ok: true });
  }

  if (request.method === "POST" && path === "lift") {
    const b = await request.json();
    const valid = PEOPLE.includes(b.person) && b.date && WORKOUTS[b.workout]?.includes(b.exercise) && b.weight >= 0 && b.reps > 0;
    if (!valid) return json({ error: "Need a name, date, exercise, weight and reps" }, 400);
    await env.DB.prepare("INSERT INTO lifts (person, date, workout, exercise, weight, reps) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(b.person, b.date, b.workout, b.exercise, b.weight, b.reps).run();
    return json({ ok: true });
  }

  if (request.method === "POST" && path === "lifts") {
    const b = await request.json();
    const raw = Array.isArray(b.sets) ? b.sets : [];
    const sets = raw.filter(x => x && (String(x.weight ?? "").trim() !== "" || String(x.reps ?? "").trim() !== ""))
                    .map(x => ({ weight: Number(x.weight), reps: Number(x.reps) }));
    const valid = PEOPLE.includes(b.person) && b.date && WORKOUTS[b.workout]?.includes(b.exercise)
      && sets.length > 0 && sets.every(x => x.weight >= 0 && x.reps > 0);
    if (!valid) return json({ error: "Need a name, date, exercise and at least one set with weight and reps" }, 400);
    const stmt = env.DB.prepare("INSERT INTO lifts (person, date, workout, exercise, weight, reps) VALUES (?, ?, ?, ?, ?, ?)");
    const clear = env.DB.prepare("DELETE FROM lifts WHERE person = ? AND date = ? AND exercise = ?").bind(b.person, b.date, b.exercise);
    await env.DB.batch([clear, ...sets.map(x => stmt.bind(b.person, b.date, b.workout, b.exercise, x.weight, x.reps))]);
    return json({ ok: true, saved: sets.length });
  }

  if (request.method === "DELETE" && (path === "weight" || path === "lift")) {
    const ids = (url.searchParams.get("ids") || url.searchParams.get("id") || "").split(",").map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (!ids.length) return json({ error: "Missing id" }, 400);
    const table = path === "weight" ? "weights" : "lifts";
    await env.DB.prepare(`DELETE FROM ${table} WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).run();
    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
}

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
    --sam:#1F4FD8; --ebe:#D9772B; --selva:#1E8E55;
    box-sizing:border-box;
  }
  @media (prefers-color-scheme: dark){
    :root{ --bg:#101A1E; --panel:#182428; --ink:#EEF2F1; --muted:#9AAAB0; --line:#2B3A40; --sam:#6C8CFF; --ebe:#F0A05A; --selva:#4CC287; --pb:#4CC287; }
  }
  *,*:before,*:after{box-sizing:inherit}
  html{scroll-padding-top:env(safe-area-inset-top,0px)}
  body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}
  main{max-width:640px;margin:0 auto;padding:20px 16px 48px}
  h1{font-size:28px;margin:8px 0 2px;letter-spacing:-.01em}
  .sub{color:var(--muted);margin:0 0 18px}
  h2{font-size:17px;margin:28px 0 10px}
  .who{display:flex;gap:8px;margin-bottom:6px}
  .who button{flex:1;padding:12px 0;border:2px solid var(--line);background:var(--panel);color:var(--ink);border-radius:12px;font-size:17px;font-weight:600;cursor:pointer}
  .who button[aria-pressed=true]{border-color:var(--p);color:var(--p)}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px}
  .row{display:flex;gap:8px;margin-top:10px}
  .row>*{flex:1;min-width:0}
  label{display:block;font-size:13px;color:var(--muted);margin-bottom:4px}
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
  .empty{color:var(--muted);font-size:15px}
  svg{width:100%;height:auto;display:block}
  .legend{display:flex;gap:14px;font-size:14px;margin-top:6px;color:var(--muted)}
  .pin{display:flex;gap:8px;margin:10px 0 0}
  .pin[hidden]{display:none}
  .pin input{flex:1}
  .pin button{padding:0 16px;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--ink);cursor:pointer}
  details summary{cursor:pointer;color:var(--muted);font-size:14px;margin-top:10px}
  .sets{display:grid;gap:8px;margin-top:12px}
  .set{display:grid;grid-template-columns:52px 1fr 1fr;gap:8px;align-items:center}
  .set .setn,.set label{font-size:13px;color:var(--muted);margin:0}
  .hint{font-size:13px;color:var(--muted);margin:8px 0 0}
  .seg{display:flex;gap:6px}
  .seg button{flex:1;padding:10px 0;border:2px solid var(--line);border-radius:10px;background:var(--panel);color:var(--ink);font-size:16px;font-weight:600;cursor:pointer}
  .seg button[aria-pressed=true]{border-color:var(--accent);color:var(--accent)}
  .steps{list-style:none;margin:14px 0 0;padding:0;display:grid;gap:6px}
  .steps button{width:100%;display:flex;align-items:center;gap:10px;padding:9px 10px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);font-size:15px;text-align:left;cursor:pointer}
  .steps .active button{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
  .tick{flex:none;width:24px;height:24px;border-radius:50%;border:1px solid var(--line);display:grid;place-items:center;font-size:12px;font-weight:600;color:var(--muted)}
  .steps .done .tick{background:var(--pb);border-color:var(--pb);color:#fff}
  .nm{flex:1;min-width:0}
  .nm small{display:block;color:var(--muted);font-size:12px}
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
</style>
</head>
<body>
<main>
  <h1>Gym Tracker</h1>
  <p class="sub">Log weigh-ins and your sets. Everyone sees everyone.</p>

  <div class="who" id="who"></div>
  <div id="pinbox" class="pin" hidden>
    <input id="pin" type="password" inputmode="numeric" placeholder="Shared PIN" aria-label="Shared PIN">
    <button id="pinsave" type="button">Remember</button>
  </div>

  <h2>Today's workout</h2>
  <div class="panel">
    <div class="row">
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
    <p class="hint">Use 0 lbs for bodyweight. Leave a set blank to skip it. Rows prefill from your last time. After saving, tap the next person: their own last numbers load if they have any, otherwise yours carry over. Saving again for the same person replaces their sets for this exercise today.</p>
    <button class="save" id="liftsave" type="button">Save sets</button>
    <div class="msg" id="liftmsg"></div>
    <div class="nav"><button type="button" id="prev">← Back</button><button type="button" id="next">Next exercise →</button></div>
    </div>
    <div class="finished" id="finished" hidden></div>
  </div>

  <h2>Weigh in</h2>
  <div class="panel">
    <div class="row">
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
</main>

<script>
(() => {
  const $ = id => document.getElementById(id);
  const colors = { Sam: "var(--sam)", Ebe: "var(--ebe)", Selva: "var(--selva)" };
  let data = null, person = null, pin = "";

  try { person = localStorage.getItem("gt_person"); pin = localStorage.getItem("gt_pin") || ""; } catch {}
  const today = new Date().toISOString().slice(0, 10);
  $("ldate").value = today; $("wdate").value = today;
  let workout = "A", step = 0, firstLoad = true;
  try {
    if (["A", "B"].includes(localStorage.getItem("gt_workout"))) workout = localStorage.getItem("gt_workout");
    const s = localStorage.getItem("gt_step") || "";
    if (s.startsWith(today + ":")) step = Number(s.slice(today.length + 1)) || 0;
  } catch {}

  function headers() { const h = { "content-type": "application/json" }; if (pin) h["x-pin"] = pin; return h; }

  async function load() {
    const r = await fetch("/api/data"); data = await r.json();
    if (!PEOPLE().includes(person)) person = PEOPLE()[0];
    $("pinbox").hidden = !data.pinRequired; $("pin").value = pin;
    renderWho(); renderChart(); renderPBs(); renderRecent();
    if (firstLoad) { firstLoad = false; go(step); } else renderFlow();
  }
  const PEOPLE = () => data.people;

  function renderWho() {
    $("who").innerHTML = PEOPLE().map(p => '<button type="button" style="--p:' + colors[p] + '" aria-pressed="' + (p === person) + '">' + p + "</button>").join("");
    [...$("who").children].forEach((b, i) => b.onclick = () => { person = PEOPLE()[i]; try { localStorage.setItem("gt_person", person); } catch {} $("liftmsg").className = "msg"; $("liftmsg").textContent = ""; renderWho(); const ex = EX()[step]; if (ex && (setsToday(person, ex).length || lastTime(person, ex))) fillFromHistory(); renderFlow(); });
  }

  const EX = () => data.workouts[workout];
  const fmt = ss => ss.map(x => x.weight + "×" + x.reps).join(", ");
  function setsToday(p, ex) { const d = $("ldate").value; return data.lifts.filter(l => l.person === p && l.exercise === ex && l.date === d).sort((a, b) => a.id - b.id); }
  function lastTime(p, ex) {
    const d = $("ldate").value, prior = data.lifts.filter(l => l.person === p && l.exercise === ex && l.date < d);
    if (!prior.length) return null;
    const date = prior[0].date;
    return { date, sets: prior.filter(l => l.date === date).sort((a, b) => a.id - b.id) };
  }
  function remember() { try { localStorage.setItem("gt_workout", workout); localStorage.setItem("gt_step", today + ":" + step); } catch {} }
  function setRows() { return [...document.querySelectorAll("#sets .set")].filter(r => r.querySelector(".sw")); }

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
      const who = PEOPLE().filter(p => setsToday(p, e).length).map(p => '<i class="chip" style="background:' + colors[p] + '" title="' + p + '"></i>').join("");
      return '<li class="' + (i === step ? "active" : "") + (mine.length ? " done" : "") + '"><button type="button" data-i="' + i + '" aria-current="' + (i === step) + '"><span class="tick">' + (mine.length ? "✓" : i + 1) + '</span><span class="nm">' + e + (mine.length ? "<small>" + fmt(mine) + "</small>" : "") + '</span><span class="whos">' + who + "</span></button></li>";
    }).join("");
    [...$("steps").querySelectorAll("button")].forEach(b => b.onclick = () => go(Number(b.dataset.i)));
    const done = step >= n;
    $("entry").hidden = done; $("finished").hidden = !done;
    if (done) {
      const count = ex.filter(e => setsToday(person, e).length).length;
      $("finished").innerHTML = "<strong>Workout " + workout + " done.</strong> " + person + " logged " + count + " of " + n + " exercises today. Tap any exercise above to add or fix sets.";
    } else {
      $("stepn").textContent = "Exercise " + (step + 1) + " of " + n;
      $("exname").textContent = ex[step];
      $("cue").textContent = (data.cues || {})[ex[step]] || "";
      const lt = lastTime(person, ex[step]), mine = setsToday(person, ex[step]);
      $("last").textContent = mine.length ? person + " today: " + fmt(mine) : lt ? person + " last time (" + lt.date + "): " + fmt(lt.sets) : "First time logging this one for " + person + ".";
      $("next").textContent = step === n - 1 ? "Finish workout ✓" : "Next exercise →";
      $("prev").disabled = step === 0;
    }
    remember();
  }
  [...$("wsel").children].forEach(b => b.onclick = () => { if (workout !== b.dataset.w) { workout = b.dataset.w; go(0); } });
  $("next").onclick = () => go(step + 1);
  $("prev").onclick = () => go(step - 1);
  $("ldate").onchange = () => go(step);

  $("pinsave").onclick = () => { pin = $("pin").value.trim(); try { localStorage.setItem("gt_pin", pin); } catch {} };

  async function post(path, body) {
    const r = await fetch("/api/" + path, { method: "POST", headers: headers(), body: JSON.stringify(body) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error || "Save failed"); return j;
  }

  function bestFor(p, ex) {
    return data.lifts.filter(l => l.person === p && l.exercise === ex).sort((a, b) => b.weight - a.weight || b.reps - a.reps)[0];
  }

  $("liftsave").onclick = async () => {
    const sets = setRows()
      .map(r => ({ weight: r.querySelector(".sw").value.trim(), reps: r.querySelector(".sr").value.trim() }))
      .filter(x => x.weight !== "" || x.reps !== "");
    const body = { person, date: $("ldate").value, workout, exercise: EX()[step], sets };
    if (!body.exercise) return;
    const prev = bestFor(person, body.exercise);
    const m = $("liftmsg"); m.className = "msg"; m.textContent = "Saving…"; $("liftsave").disabled = true;
    try {
      const r = await post("lifts", body); await load();
      const isPB = sets.some(x => { const w = Number(x.weight), rp = Number(x.reps); return !prev || w > prev.weight || (w === prev.weight && rp > prev.reps); });
      m.className = isPB ? "msg pb" : "msg";
      m.textContent = (isPB ? "New personal best! " : "") + "Saved " + r.saved + (r.saved === 1 ? " set" : " sets") + " for " + person + ". Tap the next person to log theirs, or Next exercise.";
    } catch (e) { m.className = "msg err"; m.textContent = e.message; }
    $("liftsave").disabled = false;
  };

  $("wsave").onclick = async () => {
    const m = $("wmsg"); m.className = "msg"; m.textContent = "Saving…"; $("wsave").disabled = true;
    try { await post("weight", { person, date: $("wdate").value, lbs: Number($("wlbs").value) }); await load(); m.textContent = "Saved."; $("wlbs").value = ""; }
    catch (e) { m.className = "msg err"; m.textContent = e.message; }
    $("wsave").disabled = false;
  };

  async function del(kind, ids, n) {
    if (!confirm(n > 1 ? "Delete these " + n + " sets?" : "Delete this entry?")) return;
    const r = await fetch("/api/" + kind + "?ids=" + ids, { method: "DELETE", headers: headers() });
    if (r.ok) load(); else alert("Could not delete (check PIN).");
  }
  window.gtDel = del;

  function renderChart() {
    const W = data.weights; if (!W.length) return;
    const dates = [...new Set(W.map(w => w.date))].sort();
    const xs = d => 40 + (dates.length === 1 ? 260 : (dates.indexOf(d) / (dates.length - 1)) * 520);
    const lo = Math.min(...W.map(w => w.lbs)) - 3, hi = Math.max(...W.map(w => w.lbs)) + 3;
    const ys = v => 20 + (1 - (v - lo) / (hi - lo)) * 180;
    let svg = '<svg viewBox="0 0 600 240" role="img" aria-label="Body weight over time">';
    [lo, (lo + hi) / 2, hi].forEach(v => { const y = ys(v); svg += '<line x1="40" x2="580" y1="' + y + '" y2="' + y + '" stroke="var(--line)"/><text x="36" y="' + (y + 4) + '" text-anchor="end" font-size="11" fill="var(--muted)">' + Math.round(v) + '</text>'; });
    PEOPLE().forEach(p => {
      const pts = W.filter(w => w.person === p); if (!pts.length) return;
      svg += '<polyline fill="none" stroke="' + colors[p] + '" stroke-width="2.5" points="' + pts.map(w => xs(w.date) + "," + ys(w.lbs)).join(" ") + '"/>';
      pts.forEach(w => svg += '<circle cx="' + xs(w.date) + '" cy="' + ys(w.lbs) + '" r="4" fill="' + colors[p] + '"/>');
    });
    svg += '<text x="40" y="232" font-size="11" fill="var(--muted)">' + dates[0] + '</text><text x="580" y="232" text-anchor="end" font-size="11" fill="var(--muted)">' + dates[dates.length - 1] + '</text></svg>';
    svg += '<div class="legend">' + PEOPLE().map(p => { const last = W.filter(w => w.person === p).slice(-1)[0]; return '<span><i class="chip" style="background:' + colors[p] + '"></i>' + p + (last ? " " + last.lbs + " lb" : "") + "</span>"; }).join("") + "</div>";
    $("chart").innerHTML = svg;
  }

  function renderPBs() {
    let h = "<table><tr><th>Exercise</th>" + PEOPLE().map(p => "<th>" + p + "</th>").join("") + "</tr>";
    for (const w of ["A", "B"]) {
      for (const ex of data.workouts[w]) {
        h += "<tr><td>" + ex + "</td>" + PEOPLE().map(p => { const b = bestFor(p, ex); return '<td class="n">' + (b ? b.weight + " × " + b.reps : "–") + "</td>"; }).join("") + "</tr>";
      }
    }
    $("pbs").innerHTML = h + "</table>";
  }

  function renderRecent() {
    const groups = [];
    for (const l of data.lifts) {
      const g = groups.find(x => x.d === l.date && x.p === l.person && x.ex === l.exercise);
      if (g) g.sets.push(l); else groups.push({ d: l.date, p: l.person, ex: l.exercise, sets: [l] });
    }
    const L = groups.slice(0, 25), W = data.weights.slice(-10).reverse();
    if (!L.length && !W.length) { $("recent").innerHTML = '<p class="empty">Nothing logged yet.</p>'; return; }
    let h = "<table><tr><th>Date</th><th>Who</th><th>What</th><th></th></tr>";
    const rows = [...L.map(g => { const ss = g.sets.slice().sort((a, b) => a.id - b.id); return { d: g.d, p: g.p, t: g.ex + " " + ss.map(x => x.weight + "×" + x.reps).join(", "), k: "lift", id: ss[ss.length - 1].id, ids: ss.map(x => x.id).join(","), n: ss.length }; }),
                  ...W.map(w => ({ d: w.date, p: w.person, t: "Weigh-in " + w.lbs + " lb", k: "weight", id: w.id, ids: String(w.id), n: 1 }))].sort((a, b) => b.d.localeCompare(a.d) || b.id - a.id).slice(0, 30);
    rows.forEach(r => h += '<tr><td class="n">' + r.d + '</td><td class="n"><i class="chip" style="background:' + colors[r.p] + '"></i>' + r.p + "</td><td>" + r.t + '</td><td><button class="del" type="button" onclick="gtDel(\\'' + r.k + "\\',\\'" + r.ids + "\\'," + r.n + ')">Delete</button></td></tr>');
    $("recent").innerHTML = h + "</table>";
  }

  load().catch(() => { document.querySelector("main").insertAdjacentHTML("afterbegin", '<p class="msg err">Could not reach the database. Check the DB binding.</p>'); });
})();
</script>
</body>
</html>`;
