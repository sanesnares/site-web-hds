/**
 * Serveur de dev local — 92 Rush.
 *   node scripts/dev-server.js        → http://localhost:4173
 * Sert les fichiers du jeu + /api/leaderboard avec une FAUSSE base en mémoire
 * (aucun accès à Supabase : on peut tester le classement sans toucher la prod).
 */
const http = require("http"), fs = require("fs"), path = require("path"), Module = require("module");
const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PORT) || 4173;

const db = { players: [], scores: [] }; let seq = 1;
const low = (s) => String(s).toLowerCase();
function table(name) {
  const st = { op: "select", filters: [], orders: [], lim: null, payload: null, ret: false, ors: null };
  const rows = () => db[name];
  const match = (r) => st.filters.every(([k, v]) => (k === "name_key" ? low(r.name) : r[k]) === v) &&
    (!st.ors || st.ors(r));
  const exec = () => {
    if (st.op === "select") {
      let out = rows().filter(match).map((r) => ({ ...r }));
      for (const [k, asc] of st.orders.slice().reverse()) out.sort((a, b) => (a[k] - b[k]) * (asc ? 1 : -1));
      // stable multi-key
      out.sort((a, b) => { for (const [k, asc] of st.orders) { const d = (a[k] - b[k]) * (asc ? 1 : -1); if (d) return d; } return 0; });
      if (st.lim != null) out = out.slice(0, st.lim);
      return { data: out, error: null };
    }
    if (st.op === "update") {
      const hit = rows().filter(match);
      for (const r of hit) {
        if (st.payload.name && rows().some((o) => o !== r && low(o.name) === low(st.payload.name) && (name === "players" || o.season === r.season)))
          return { data: null, error: { code: "23505", message: "duplicate" } };
        Object.assign(r, st.payload);
      }
      return { data: st.ret ? hit.map((r) => ({ id: r.id })) : null, error: null };
    }
    if (st.op === "delete") { db[name] = rows().filter((r) => !match(r)); return { data: null, error: null }; }
    if (st.op === "insert") {
      if (rows().some((o) => low(o.name) === low(st.payload.name) && o.season === st.payload.season)) return { data: null, error: { code: "23505", message: "duplicate" } };
      rows().push({ id: seq++, ...st.payload }); return { data: null, error: null };
    }
    if (st.op === "upsert") {
      const ex = rows().find((r) => r.device_id === st.payload.device_id);
      if (rows().some((o) => o !== ex && low(o.name) === low(st.payload.name))) return { data: null, error: { code: "23505", message: "duplicate" } };
      if (ex) Object.assign(ex, st.payload); else rows().push({ ...st.payload });
      return { data: null, error: null };
    }
  };
  const b = {
    select(c) { if (st.op !== "select") st.ret = true; return b; },
    eq(k, v) { st.filters.push([k, v]); return b; },
    or(s) { const id = s.split("neq.")[1]; st.ors = (r) => r.device_id == null || r.device_id !== id; return b; },
    order(k, o) { st.orders.push([k, !o || o.ascending !== false]); return b; },
    limit(n) { st.lim = n; return b; },
    update(p) { st.op = "update"; st.payload = p; return b; },
    delete() { st.op = "delete"; return b; },
    insert(p) { st.op = "insert"; st.payload = p; return b; },
    upsert(p) { st.op = "upsert"; st.payload = p; return b; },
    maybeSingle() { const r = exec(); return Promise.resolve({ data: (r.data && r.data[0]) || null, error: r.error }); },
    then(f, g) { return Promise.resolve(exec()).then(f, g); },
  };
  return b;
}

db.scores.push(
  { id: seq++, season: 4, name: "Ysemo", device_id: "seed-ysemo-0001", time_ms: 63727, meters: 890, cams: 21, win: false, at: new Date().toISOString(), rose_at: null },
  { id: seq++, season: 4, name: "Jul", device_id: "seed-jul-00001", time_ms: 56112, meters: 780, cams: 14, win: false, at: new Date().toISOString(), rose_at: null }
);
db.players.push({ device_id: "seed-ysemo-0001", name: "Ysemo" }, { device_id: "seed-jul-00001", name: "Jul" });

const orig = Module._load;
Module._load = function (req, ...a) {
  return req === "@supabase/supabase-js" ? { createClient: () => ({ from: table }) } : orig.call(this, req, ...a);
};
process.env.SUPABASE_URL = "https://local.supabase.co";
process.env.SUPABASE_SECRET_KEY = "local";
const leaderboard = require(path.join(ROOT, "api/leaderboard.js"));

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/manifest+json",
  ".webmanifest": "application/manifest+json", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".css": "text/css" };

// Mêmes en-têtes de sécurité qu’en prod (vercel.json) pour détecter un blocage CSP en local
let SEC_HEADERS = [];
try {
  const vj = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
  SEC_HEADERS = (vj.headers.find((h) => h.source === "/(.*)") || { headers: [] }).headers;
} catch (_) {}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  for (const h of SEC_HEADERS) res.setHeader(h.key, h.value);
  if (url.pathname === "/api/leaderboard") {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch (_) {}
      const r = { method: req.method, headers: req.headers, body, query: Object.fromEntries(url.searchParams), socket: req.socket };
      const w = {
        setHeader: (k, v) => res.setHeader(k, v),
        status(c) { res.statusCode = c; return w; },
        json(o) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); },
        end: () => res.end(),
      };
      leaderboard(r, w).catch((e) => { res.statusCode = 500; res.end(String(e)); });
    });
    return;
  }
  if (url.pathname === "/__db") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(db)); return; }
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; res.end("404"); return; }
  res.setHeader("Content-Type", TYPES[path.extname(file).toLowerCase()] || "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log("92 Rush dev → http://localhost:" + PORT));
