/**
 * Classement partagé 92 Rush — Supabase (saison 4).
 * GET  → ?deviceId=… → { scores, me, season }
 * POST → { scores, name?, deviceId? } → claim pseudo + upsert best score
 *
 * Un téléphone = un deviceId (localStorage). Jamais d’IP → pseudo.
 * Le deviceId est la seule preuve d’identité : il ne sort JAMAIS dans `scores`.
 * Accès DB uniquement via la clé secrète Supabase (serveur).
 */

const { createClient } = require("@supabase/supabase-js");

const MAX = 40;
const SEASON = 4;

/* —— Bornes de plausibilité (doivent suivre index.html) —— */
const FINISH_METERS = 920;
const MAX_CAMS = 999;
const MAX_TIME_MS = 9 * 3600 * 1000;
// Vitesse max théorique : 340 px/s (shoes) × 1,15 (scooter) × 1,42 (stomp) / 18 px/m ≈ 31 m/s
const MAX_METERS_PER_SEC = 35;
const MIN_WIN_TIME_MS = Math.floor((FINISH_METERS / MAX_METERS_PER_SEC) * 1000); // ≈ 26 s

/* —— Anti-spam (best effort : mémoire par instance) —— */
const POST_COOLDOWN_MS = 1200;
const IP_WINDOW_MS = 60 * 1000;
const IP_MAX_POSTS = 30;
const RATE_MAX_KEYS = 5000;
const deviceLastPost = new Map();
const ipPosts = new Map();

/* —— Cache court du top (les écrans classement pollent) —— */
const TOP_TTL_MS = 2000;
let topCache = null;
let topCacheAt = 0;

const ALLOWED_ORIGINS = new Set([
  "https://92rush.vercel.app",
  "https://site-web-hds.vercel.app",
]);

const SCORE_COLS = "id, season, name, device_id, time_ms, meters, cams, win, at, rose_at";

function getSupabase() {
  const url = String(process.env.SUPABASE_URL || "").trim();
  // Dashboard récent : SUPABASE_SECRET_KEY ; ancien nom : SERVICE_ROLE
  const key = String(
    process.env.SUPABASE_SERVICE_ROLE_KEY
      || process.env.SUPABASE_SECRET_KEY
      || ""
  ).trim();
  if (!url || !/^https:\/\//i.test(url) || !key) {
    const err = new Error("missing_supabase_env");
    err.code = "missing_supabase_env";
    throw err;
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function int(v) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : 0;
}

function rank(a, b) {
  if (!!a.win !== !!b.win) return a.win ? -1 : 1;
  if (a.win && b.win) return int(a.timeMs) - int(b.timeMs);
  if (int(a.meters) !== int(b.meters)) return int(b.meters) - int(a.meters);
  if (int(a.cams) !== int(b.cams)) return int(b.cams) - int(a.cams);
  return int(a.timeMs) - int(b.timeMs);
}

function cleanDeviceId(raw) {
  const id = String(raw || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return id.length >= 8 ? id : "";
}

/**
 * Pseudo : NFKC, sans caractères invisibles / de contrôle / bidi,
 * sans balises, 20 caractères max (points de code, pas de surrogate coupé).
 */
function cleanName(raw) {
  let s = String(raw == null ? "" : raw);
  try { s = s.normalize("NFKC"); } catch (_) {}
  s = s
    .replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "")
    .replace(/[<>&"'`\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  s = Array.from(s).slice(0, 20).join("").trim();
  // Au moins un caractère visible (lettre, chiffre, symbole)
  if (!/[\p{L}\p{N}\p{S}\p{P}]/u.test(s)) return "";
  return s;
}

function cleanIncomingScore(e) {
  if (!e || typeof e !== "object") return null;
  if (int(e.season) !== SEASON) return null;
  const name = cleanName(e.name);
  if (!name) return null;
  const timeMs = int(e.timeMs);
  const meters = int(e.meters);
  const cams = int(e.cams);
  const win = !!e.win;
  if (timeMs <= 0 || timeMs > MAX_TIME_MS) return null;
  if (meters < 0 || meters > FINISH_METERS) return null;
  if (cams < 0 || cams > MAX_CAMS) return null;
  // Une victoire = arrivée atteinte, en un temps physiquement possible
  if (win && (meters < FINISH_METERS || timeMs < MIN_WIN_TIME_MS)) return null;
  // Distance impossible pour le temps écoulé (marge de 10 m)
  if (meters > (timeMs / 1000) * MAX_METERS_PER_SEC + 10) return null;
  // Date = heure serveur (on ne fait pas confiance à l’horloge du client)
  return { name, timeMs, meters, cams, win, at: Date.now(), season: SEASON };
}

function rowToScore(row) {
  if (!row) return null;
  const atMs = row.at ? new Date(row.at).getTime() : Date.now();
  const roseMs = row.rose_at ? new Date(row.rose_at).getTime() : 0;
  const out = {
    id: String(row.id != null ? row.id : row.name_key || row.name),
    name: row.name,
    timeMs: int(row.time_ms),
    meters: int(row.meters),
    cams: int(row.cams),
    win: !!row.win,
    at: atMs,
    season: int(row.season) || SEASON,
  };
  // Jamais de device_id dans la réponse : c'est la seule preuve d'identité.
  if (roseMs && Date.now() - roseMs < 90 * 1000) out.roseAt = roseMs;
  return out;
}

function isBetter(candidate, existing) {
  if (!existing) return true;
  return rank(candidate, existing) < 0;
}

/** Top trié en SQL (même ordre que rank) : victoires par temps, puis distance. */
async function fetchTopScores(sb, { fresh } = {}) {
  const now = Date.now();
  if (!fresh && topCache && now - topCacheAt < TOP_TTL_MS) return topCache;

  const [wins, runs] = await Promise.all([
    sb.from("scores").select(SCORE_COLS)
      .eq("season", SEASON).eq("win", true)
      .order("time_ms", { ascending: true })
      .limit(MAX),
    sb.from("scores").select(SCORE_COLS)
      .eq("season", SEASON).eq("win", false)
      .order("meters", { ascending: false })
      .order("cams", { ascending: false })
      .order("time_ms", { ascending: true })
      .limit(MAX),
  ]);
  if (wins.error) throw wins.error;
  if (runs.error) throw runs.error;

  const scores = [].concat(wins.data || [], runs.data || [])
    .map(rowToScore)
    .filter(Boolean)
    .sort(rank)
    .slice(0, MAX);
  topCache = scores;
  topCacheAt = Date.now();
  return scores;
}

async function getPlayer(sb, deviceId) {
  const { data, error } = await sb
    .from("players")
    .select("device_id, name")
    .eq("device_id", deviceId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function getDeviceScoreRow(sb, deviceId) {
  const { data, error } = await sb
    .from("scores")
    .select(SCORE_COLS)
    .eq("season", SEASON)
    .eq("device_id", deviceId)
    .order("id", { ascending: true })
    .limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

async function resolveMe(sb, deviceId) {
  if (!deviceId) return null;
  const player = await getPlayer(sb, deviceId);
  if (!player || !player.name) return null;
  const scoreRow = await getDeviceScoreRow(sb, deviceId);
  return {
    name: player.name,
    entry: rowToScore(scoreRow),
    deviceId,
  };
}

function readDeviceId(req, body) {
  if (body && body.deviceId) return cleanDeviceId(body.deviceId);
  try {
    const h = req.headers && req.headers["x-device-id"];
    if (h) return cleanDeviceId(h);
    const q = req.query && req.query.deviceId;
    if (q) return cleanDeviceId(q);
  } catch (_) {}
  return "";
}

function isUniqueViolation(err) {
  return !!err && (String(err.code) === "23505" || /unique|duplicate/i.test(err.message || ""));
}

/**
 * Lie le pseudo à l’appareil. Si l’appareil change de pseudo, sa ligne de score
 * suit le nouveau nom (pas de ligne fantôme laissée au classement).
 */
async function claimOrCheckName(sb, deviceId, claimName) {
  const nameKey = claimName.toLowerCase();
  const { data: owner, error } = await sb
    .from("players")
    .select("device_id, name")
    .eq("name_key", nameKey)
    .maybeSingle();
  if (error) throw error;
  if (owner && owner.device_id !== deviceId) {
    return { nameTaken: true, canClaim: false };
  }

  const current = owner || (await getPlayer(sb, deviceId));
  if (current && current.name === claimName) {
    return { nameTaken: false, canClaim: true };
  }

  const { error: upErr } = await sb.from("players").upsert(
    { device_id: deviceId, name: claimName, updated_at: new Date().toISOString() },
    { onConflict: "device_id" }
  );
  if (upErr) {
    // Course : un autre device a pris le name_key entre-temps
    if (isUniqueViolation(upErr)) return { nameTaken: true, canClaim: false };
    throw upErr;
  }

  // Le pseudo est à nous : une éventuelle vieille ligne de score sous ce nom
  // (orpheline ou d’un autre appareil) ne doit pas être héritée.
  const { error: delErr } = await sb
    .from("scores")
    .delete()
    .eq("season", SEASON)
    .eq("name_key", nameKey)
    .or("device_id.is.null,device_id.neq." + deviceId);
  if (delErr) throw delErr;

  // Renommage : le score de l’appareil suit le nouveau pseudo.
  const { error: renErr } = await sb
    .from("scores")
    .update({ name: claimName })
    .eq("season", SEASON)
    .eq("device_id", deviceId);
  if (renErr && !isUniqueViolation(renErr)) throw renErr;

  topCache = null;
  return { nameTaken: false, canClaim: true };
}

/** Garde le meilleur score de l’appareil. Écriture conditionnelle (pas d’écrasement en course). */
async function upsertBestScore(sb, deviceId, entry) {
  const prevRow = await getDeviceScoreRow(sb, deviceId);
  const prev = rowToScore(prevRow);
  if (prev && !isBetter(entry, prev)) return false;

  const payload = {
    season: SEASON,
    name: entry.name,
    device_id: deviceId,
    time_ms: entry.timeMs,
    meters: entry.meters,
    cams: entry.cams,
    win: entry.win,
    at: new Date().toISOString(),
    rose_at: prevRow ? new Date().toISOString() : null,
  };

  if (prevRow) {
    // Verrou optimiste : n’écrit que si la ligne n’a pas bougé depuis la lecture
    const { data, error } = await sb
      .from("scores")
      .update(payload)
      .eq("id", prevRow.id)
      .eq("time_ms", prevRow.time_ms)
      .eq("meters", prevRow.meters)
      .eq("cams", prevRow.cams)
      .eq("win", prevRow.win)
      .select("id");
    if (error) throw error;
    if (!data || !data.length) return false;
  } else {
    const { error } = await sb.from("scores").insert(payload);
    if (error) {
      // Course (double envoi) ou nom déjà en base : le prochain envoi réconciliera
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }
  topCache = null;
  return true;
}

function pickBestIncoming(incoming, name) {
  let best = null;
  const key = name.toLowerCase();
  const list = Array.isArray(incoming) ? incoming.slice(0, 60) : [];
  for (const raw of list) {
    const e = cleanIncomingScore(raw);
    if (!e) continue;
    if (e.name.toLowerCase() !== key) continue;
    if (!best || isBetter(e, best)) best = e;
  }
  if (best) best.name = name;
  return best;
}

function clientIp(req) {
  try {
    const xf = String((req.headers && req.headers["x-forwarded-for"]) || "");
    const ip = xf.split(",")[0].trim();
    return ip || (req.socket && req.socket.remoteAddress) || "";
  } catch (_) {
    return "";
  }
}

function prune(map) {
  if (map.size <= RATE_MAX_KEYS) return;
  let n = map.size - RATE_MAX_KEYS + 500;
  for (const k of map.keys()) {
    map.delete(k);
    if (--n <= 0) break;
  }
}

/** true = requête à freiner */
function isThrottled(req, deviceId) {
  const now = Date.now();
  let throttled = false;

  const ip = clientIp(req);
  if (ip) {
    let slot = ipPosts.get(ip);
    if (!slot || now - slot.start > IP_WINDOW_MS) slot = { start: now, n: 0 };
    slot.n += 1;
    ipPosts.set(ip, slot);
    if (slot.n > IP_MAX_POSTS) throttled = true;
    prune(ipPosts);
  }

  if (deviceId) {
    const last = deviceLastPost.get(deviceId) || 0;
    if (now - last < POST_COOLDOWN_MS) throttled = true;
    else deviceLastPost.set(deviceId, now);
    prune(deviceLastPost);
  }
  return throttled;
}

function setCors(req, res) {
  const origin = String((req.headers && req.headers.origin) || "");
  if (ALLOWED_ORIGINS.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Device-Id");
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  try {
    const sb = getSupabase();

    if (req.method === "GET") {
      const deviceId = readDeviceId(req, null);
      const [scores, me] = await Promise.all([
        fetchTopScores(sb),
        resolveMe(sb, deviceId),
      ]);
      res.status(200).json({ scores, me, season: SEASON });
      return;
    }

    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") {
        try {
          body = JSON.parse(body);
        } catch (_) {
          body = {};
        }
      }
      if (!body || typeof body !== "object") body = {};
      const deviceId = readDeviceId(req, body);

      if (isThrottled(req, deviceId)) {
        // Aucune écriture : on renvoie juste le top (souvent depuis le cache)
        const scores = await fetchTopScores(sb);
        res.status(200).json({ scores, me: null, season: SEASON, throttled: true });
        return;
      }

      const claimName = cleanName(body.name);
      let nameTaken = false;

      if (deviceId) {
        let myName = "";
        if (claimName) {
          const claim = await claimOrCheckName(sb, deviceId, claimName);
          nameTaken = !!claim.nameTaken;
          if (claim.canClaim) myName = claimName;
        } else {
          // Score sans renommer : pseudo déjà lié à l’appareil
          const player = await getPlayer(sb, deviceId);
          if (player && player.name) myName = player.name;
        }
        if (myName) {
          const best = pickBestIncoming(body.scores, myName);
          if (best) await upsertBestScore(sb, deviceId, best);
        }
      }

      const [scores, me] = await Promise.all([
        fetchTopScores(sb, { fresh: true }),
        resolveMe(sb, deviceId),
      ]);
      res.status(200).json({ scores, me, nameTaken, season: SEASON });
      return;
    }

    res.status(405).json({ error: "method" });
  } catch (err) {
    const code = err && err.code;
    if (code === "missing_supabase_env") {
      res.status(503).json({
        error: "supabase_not_configured",
        scores: [],
        me: null,
        season: SEASON,
      });
      return;
    }
    console.error("[leaderboard]", err && err.message ? err.message : err);
    res.status(500).json({
      error: "server",
      scores: [],
      me: null,
      season: SEASON,
    });
  }
};

// Exposé pour les tests locaux uniquement
module.exports._test = { cleanName, cleanIncomingScore, rank, pickBestIncoming };
