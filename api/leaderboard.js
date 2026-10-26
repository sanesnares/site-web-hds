/**
 * Classement partagé 92 Rush — Supabase (saison 4).
 * GET  → ?deviceId=… → { scores, me, season }
 * POST → { scores, name?, deviceId? } → claim pseudo + upsert best score
 *
 * Un téléphone = un deviceId (localStorage). Jamais d’IP → pseudo.
 * Accès DB uniquement via SUPABASE_SERVICE_ROLE_KEY (serveur).
 */

const { createClient } = require("@supabase/supabase-js");

const MAX = 40;
const SEASON = 4;
const POST_COOLDOWN_MS = 1200;

const rateLimit = Object.create(null);

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

function rank(a, b) {
  if (!!a.win !== !!b.win) return a.win ? -1 : 1;
  if (a.win && b.win) return (a.timeMs | 0) - (b.timeMs | 0);
  if ((a.meters | 0) !== (b.meters | 0)) return (b.meters | 0) - (a.meters | 0);
  if ((a.cams | 0) !== (b.cams | 0)) return (b.cams | 0) - (a.cams | 0);
  return (a.timeMs | 0) - (b.timeMs | 0);
}

function cleanDeviceId(raw) {
  const id = String(raw || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return id.length >= 8 ? id : "";
}

function cleanName(raw) {
  return String(raw || "")
    .trim()
    .slice(0, 20)
    .replace(/[<>&"']/g, "");
}

function cleanIncomingScore(e) {
  if (!e || typeof e !== "object") return null;
  if ((e.season | 0) !== SEASON) return null;
  const name = cleanName(e.name);
  if (!name) return null;
  const timeMs = Math.max(0, Math.min(9 * 3600 * 1000, e.timeMs | 0));
  const meters = Math.max(0, Math.min(5000, e.meters | 0));
  const cams = Math.max(0, Math.min(999, e.cams | 0));
  const win = !!e.win;
  const at = Math.max(0, e.at | 0) || Date.now();
  return { name, timeMs, meters, cams, win, at, season: SEASON };
}

function rowToScore(row) {
  if (!row) return null;
  const atMs = row.at ? new Date(row.at).getTime() : Date.now();
  const roseMs = row.rose_at ? new Date(row.rose_at).getTime() : 0;
  const out = {
    id: String(row.id != null ? row.id : row.name_key || row.name),
    name: row.name,
    timeMs: row.time_ms | 0,
    meters: row.meters | 0,
    cams: row.cams | 0,
    win: !!row.win,
    at: atMs,
    season: row.season | 0 || SEASON,
  };
  if (row.device_id) out.did = row.device_id;
  if (roseMs && Date.now() - roseMs < 90 * 1000) out.roseAt = roseMs;
  return out;
}

function isBetter(candidate, existing) {
  if (!existing) return true;
  return rank(candidate, existing) < 0;
}

async function fetchTopScores(sb) {
  const { data, error } = await sb
    .from("scores")
    .select("id, season, name, device_id, time_ms, meters, cams, win, at, rose_at")
    .eq("season", SEASON)
    .limit(200);
  if (error) throw error;
  const scores = (data || []).map(rowToScore).filter(Boolean);
  scores.sort(rank);
  return scores.slice(0, MAX);
}

async function resolveMe(sb, deviceId) {
  if (!deviceId) return null;
  const { data: player, error: pErr } = await sb
    .from("players")
    .select("device_id, name")
    .eq("device_id", deviceId)
    .maybeSingle();
  if (pErr) throw pErr;
  if (!player || !player.name) return null;

  const { data: scoreRow, error: sErr } = await sb
    .from("scores")
    .select("id, season, name, device_id, time_ms, meters, cams, win, at, rose_at")
    .eq("season", SEASON)
    .eq("name_key", player.name.toLowerCase())
    .maybeSingle();
  if (sErr) throw sErr;

  return {
    name: player.name,
    entry: rowToScore(scoreRow),
    deviceId,
  };
}

function readDeviceId(req, body) {
  if (body && body.deviceId) return cleanDeviceId(body.deviceId);
  try {
    const q = req.query && req.query.deviceId;
    if (q) return cleanDeviceId(q);
  } catch (_) {}
  return "";
}

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

  const now = new Date().toISOString();
  const { error: upErr } = await sb.from("players").upsert(
    {
      device_id: deviceId,
      name: claimName,
      updated_at: now,
    },
    { onConflict: "device_id" }
  );
  if (upErr) {
    // Course : un autre device a pris le name_key entre-temps
    if (String(upErr.code) === "23505" || /unique|duplicate/i.test(upErr.message || "")) {
      return { nameTaken: true, canClaim: false };
    }
    throw upErr;
  }

  // Vérifier qu’on n’a pas volé un name déjà pris (race sur name_key)
  const { data: verify } = await sb
    .from("players")
    .select("device_id")
    .eq("name_key", nameKey)
    .maybeSingle();
  if (verify && verify.device_id !== deviceId) {
    return { nameTaken: true, canClaim: false };
  }

  // Lier le score existant de ce pseudo à ce device (pseudo libéré / reclaim)
  await sb
    .from("scores")
    .update({ device_id: deviceId })
    .eq("season", SEASON)
    .eq("name_key", nameKey);

  return { nameTaken: false, canClaim: true };
}

async function upsertBestScore(sb, deviceId, entry) {
  const nameKey = entry.name.toLowerCase();
  const { data: prevRow, error: prevErr } = await sb
    .from("scores")
    .select("id, season, name, device_id, time_ms, meters, cams, win, at, rose_at")
    .eq("season", SEASON)
    .eq("name_key", nameKey)
    .maybeSingle();
  if (prevErr) throw prevErr;

  const prev = rowToScore(prevRow);
  // Refuser d’écraser le score d’un autre device (sauf si ce device possède le pseudo)
  if (prevRow && prevRow.device_id && deviceId && prevRow.device_id !== deviceId) {
    const { data: owner } = await sb
      .from("players")
      .select("device_id")
      .eq("name_key", nameKey)
      .maybeSingle();
    if (!owner || owner.device_id !== deviceId) return false;
  }

  const candidate = {
    name: entry.name,
    timeMs: entry.timeMs,
    meters: entry.meters,
    cams: entry.cams,
    win: entry.win,
    at: entry.at,
    season: SEASON,
  };

  if (prev && !isBetter(candidate, prev)) {
    // Lier device_id si manquant
    if (deviceId && prevRow && !prevRow.device_id) {
      await sb
        .from("scores")
        .update({ device_id: deviceId })
        .eq("id", prevRow.id);
    }
    return false;
  }

  const rose = prev && isBetter(candidate, prev);
  const payload = {
    season: SEASON,
    name: entry.name,
    device_id: deviceId || (prevRow && prevRow.device_id) || null,
    time_ms: entry.timeMs,
    meters: entry.meters,
    cams: entry.cams,
    win: entry.win,
    at: new Date(entry.at || Date.now()).toISOString(),
    rose_at: rose ? new Date().toISOString() : prevRow && prevRow.rose_at ? prevRow.rose_at : null,
  };

  if (prevRow && prevRow.id != null) {
    const { error } = await sb.from("scores").update(payload).eq("id", prevRow.id);
    if (error) throw error;
  } else {
    const { error } = await sb.from("scores").insert(payload);
    if (error) {
      if (String(error.code) === "23505") {
        // Retry update on race
        const { error: e2 } = await sb
          .from("scores")
          .update(payload)
          .eq("season", SEASON)
          .eq("name_key", nameKey);
        if (e2) throw e2;
      } else {
        throw error;
      }
    }
  }
  return true;
}

function pickBestIncoming(incoming, claimName, deviceId) {
  let best = null;
  for (const raw of incoming || []) {
    const e = cleanIncomingScore(raw);
    if (!e) continue;
    if (claimName && e.name.toLowerCase() !== claimName.toLowerCase()) continue;
    if (!claimName && deviceId) {
      // sans claim : n’accepter que si le nom matche déjà (géré côté claim)
    }
    if (!best || isBetter(e, best)) best = e;
  }
  return best;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store, max-age=0");
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
      const deviceId = readDeviceId(req, body);

      if (deviceId) {
        const now = Date.now();
        const lastAt = rateLimit[deviceId] || 0;
        if (now - lastAt < POST_COOLDOWN_MS) {
          const [scores, me] = await Promise.all([
            fetchTopScores(sb),
            resolveMe(sb, deviceId),
          ]);
          res.status(200).json({
            scores,
            me,
            season: SEASON,
            throttled: true,
          });
          return;
        }
        rateLimit[deviceId] = now;
      }

      const claimName = cleanName(body && body.name);
      let nameTaken = false;

      if (claimName && deviceId) {
        const claim = await claimOrCheckName(sb, deviceId, claimName);
        nameTaken = !!claim.nameTaken;
        if (claim.canClaim) {
          const best = pickBestIncoming(
            (body && body.scores) || [],
            claimName,
            deviceId
          );
          if (best) {
            await upsertBestScore(sb, deviceId, best);
          }
        }
      } else if (deviceId && Array.isArray(body && body.scores) && body.scores.length) {
        // Submit score sans renommer : utiliser le pseudo déjà lié à l’appareil
        const me = await resolveMe(sb, deviceId);
        if (me && me.name) {
          const best = pickBestIncoming(body.scores, me.name, deviceId);
          if (best) {
            best.name = me.name;
            await upsertBestScore(sb, deviceId, best);
          }
        }
      }

      const [scores, me] = await Promise.all([
        fetchTopScores(sb),
        resolveMe(sb, deviceId),
      ]);
      res.status(200).json({
        scores,
        me,
        nameTaken,
        season: SEASON,
      });
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
