/**
 * Classement partagé 92 Rush — merge gossip + identité APPAREIL.
 * GET  → ?deviceId=… → { scores, me }
 * POST → { scores, name?, deviceId? } → merge + lie le pseudo à l’appareil
 *
 * Un téléphone = un deviceId (localStorage). Jamais d’IP → pseudo
 * (sinon toute une classe derrière le même Wi‑Fi partage le même compte).
 */

const MAX = 40;
const SEASON = 3;
const BLOB_PATHNAME = "hds92-leaderboard-s" + SEASON + "-dev.json";
const POST_COOLDOWN_MS = 1200;
const PERSIST_MIN_INTERVAL_MS = 1500;

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

function cleanEntry(e) {
  if (!e || typeof e !== "object") return null;
  if ((e.season | 0) !== SEASON) return null;
  const name = String(e.name || "")
    .trim()
    .slice(0, 20)
    .replace(/[<>&"']/g, "");
  if (!name) return null;
  const timeMs = Math.max(0, Math.min(9 * 3600 * 1000, e.timeMs | 0));
  const meters = Math.max(0, Math.min(5000, e.meters | 0));
  const cams = Math.max(0, Math.min(999, e.cams | 0));
  const win = !!e.win;
  const at = Math.max(0, e.at | 0) || Date.now();
  const id = String(e.id || name.toLowerCase() + "_" + at).slice(0, 64);
  const did = cleanDeviceId(e.did);
  const roseAt = Math.max(0, e.roseAt | 0);
  const out = { id, name, timeMs, meters, cams, win, at, season: SEASON };
  if (did) out.did = did;
  if (roseAt && Date.now() - roseAt < 90 * 1000) out.roseAt = roseAt;
  return out;
}

function findOwnerDeviceId(mem, nameLower) {
  if (!mem || !nameLower) return "";
  for (const e of mem.scores || []) {
    if (e && e.name && e.name.toLowerCase() === nameLower && e.did) {
      return e.did;
    }
  }
  const devs = mem.devices || {};
  for (const did of Object.keys(devs)) {
    const d = devs[did];
    if (d && d.name && d.name.toLowerCase() === nameLower) {
      return did;
    }
  }
  return "";
}

function mergeBoards(existingScores, incomingScores, mem) {
  const byName = new Map();

  for (const raw of existingScores || []) {
    const e = cleanEntry(raw);
    if (!e) continue;
    byName.set(e.name.toLowerCase(), e);
  }

  for (const raw of incomingScores || []) {
    const e = cleanEntry(raw);
    if (!e) continue;
    const key = e.name.toLowerCase();
    const prev = byName.get(key);

    const ownerDid = (prev && prev.did) || findOwnerDeviceId(mem, key);
    if (ownerDid && e.did && e.did !== ownerDid) {
      continue;
    }
    if (ownerDid && !e.did) {
      e.did = ownerDid;
    }

    if (!prev || rank(e, prev) < 0) {
      if (prev && rank(e, prev) < 0) {
        e.roseAt = Date.now();
      } else if (e.roseAt && prev && prev.roseAt && prev.roseAt > e.roseAt) {
        e.roseAt = prev.roseAt;
      }
      if (!e.did && prev && prev.did) e.did = prev.did;
      byName.set(key, e);
    } else if (prev && !prev.did && e.did && (!ownerDid || ownerDid === e.did)) {
      prev.did = e.did;
      byName.set(key, prev);
    }
  }

  return Array.from(byName.values()).sort(rank).slice(0, MAX);
}

function getMem() {
  const key = "__HDS92_STORE_S" + SEASON + "_DEV";
  if (!globalThis[key]) {
    globalThis[key] = {
      scores: [],
      devices: Object.create(null),
      rateLimit: Object.create(null),
      lastPersistAt: 0,
      season: SEASON,
    };
  }
  return globalThis[key];
}

function rebuildDevicesFromScores(scores, devices) {
  const map = devices && typeof devices === "object" ? { ...devices } : Object.create(null);
  for (const e of scores || []) {
    if (!e || !e.did || !e.name) continue;
    const prev = map[e.did];
    if (!prev || (e.at | 0) >= (prev.at | 0)) {
      map[e.did] = { name: e.name, at: e.at | 0 || Date.now() };
    }
  }
  return map;
}

async function loadPersist() {
  const mem = getMem();
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token || mem._loaded) return mem;
  try {
    const url =
      process.env.HDS92_BLOB_URL ||
      ("https://blob.vercel-storage.com/" + BLOB_PATHNAME);
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + token,
        "x-api-version": "7",
      },
    });
    if (res.ok) {
      const data = await res.json();
      const scores = mergeBoards(data.scores || [], mem.scores || [], mem);
      const devices = rebuildDevicesFromScores(
        scores,
        data.devices || mem.devices
      );
      mem.scores = scores;
      mem.devices = devices;
    }
  } catch (_) {}
  mem._loaded = true;
  return mem;
}

async function persistNow(mem, force) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return;
  const now = Date.now();
  if (!force && now - (mem.lastPersistAt || 0) < PERSIST_MIN_INTERVAL_MS) return;
  mem.lastPersistAt = now;
  try {
    const body = JSON.stringify({
      scores: mem.scores || [],
      devices: mem.devices || {},
      at: now,
    });
    await fetch("https://blob.vercel-storage.com/" + BLOB_PATHNAME, {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + token,
        "x-api-version": "7",
        "x-content-type": "application/json",
        "x-vercel-blob-access": "private",
        "x-add-random-suffix": "0",
        "x-allow-overwrite": "true",
      },
      body,
    });
  } catch (_) {}
}

function resolveMe(mem, deviceId) {
  if (!deviceId) return null;
  const bind = mem.devices && mem.devices[deviceId];
  let name = bind && bind.name ? String(bind.name) : "";
  if (!name) {
    const hit = (mem.scores || []).find((e) => e && e.did === deviceId);
    if (hit) name = hit.name;
  }
  if (!name) return null;
  const entry =
    (mem.scores || []).find((e) => e.name.toLowerCase() === name.toLowerCase()) || null;
  return { name, entry, deviceId };
}

function bindDevice(mem, deviceId, name) {
  if (!deviceId || !name) return;
  const key = name.toLowerCase();
  const ownerDid = findOwnerDeviceId(mem, key);
  if (ownerDid && ownerDid !== deviceId) return;

  mem.devices[deviceId] = { name, at: Date.now() };
  mem.scores = (mem.scores || []).map((e) => {
    if (e.name.toLowerCase() !== key) return e;
    if (e.did && e.did !== deviceId) return e;
    return { ...e, did: deviceId };
  });
}

function readDeviceId(req, body) {
  if (body && body.deviceId) return cleanDeviceId(body.deviceId);
  try {
    const q = req.query && req.query.deviceId;
    if (q) return cleanDeviceId(q);
  } catch (_) {}
  return "";
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
    const mem = await loadPersist();

    if (req.method === "GET") {
      const deviceId = readDeviceId(req, null);
      mem.devices = rebuildDevicesFromScores(mem.scores, mem.devices);
      res.status(200).json({
        scores: mem.scores || [],
        me: resolveMe(mem, deviceId),
        season: SEASON,
      });
      return;
    }

    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch (_) { body = {}; }
      }
      const deviceId = readDeviceId(req, body);

      if (deviceId) {
        const now = Date.now();
        const lastAt = mem.rateLimit[deviceId] || 0;
        if (now - lastAt < POST_COOLDOWN_MS) {
          res.status(200).json({
            scores: mem.scores || [],
            me: resolveMe(mem, deviceId),
            season: SEASON,
            throttled: true,
          });
          return;
        }
        mem.rateLimit[deviceId] = now;
      }

      const incoming = (body && body.scores) || [];
      const claimName = String((body && body.name) || "")
        .trim()
        .slice(0, 20)
        .replace(/[<>&"']/g, "");

      const claimOwner = claimName ? findOwnerDeviceId(mem, claimName.toLowerCase()) : "";
      const canClaim = !claimOwner || claimOwner === deviceId;
      const nameTaken = !!(claimName && claimOwner && claimOwner !== deviceId);

      const stamped = (Array.isArray(incoming) ? incoming : []).map((raw) => {
        const e = cleanEntry(raw);
        if (!e) return null;
        if (
          deviceId &&
          claimName &&
          canClaim &&
          e.name.toLowerCase() === claimName.toLowerCase()
        ) {
          e.did = deviceId;
        }
        return e;
      }).filter(Boolean);

      const prevSnap = JSON.stringify(mem.scores);
      mem.scores = mergeBoards(mem.scores, stamped, mem);
      if (deviceId && claimName && canClaim) {
        bindDevice(mem, deviceId, claimName);
      }
      mem.devices = rebuildDevicesFromScores(mem.scores, mem.devices);

      const changed = JSON.stringify(mem.scores) !== prevSnap;
      await persistNow(mem, changed);

      res.status(200).json({
        scores: mem.scores,
        me: resolveMe(mem, deviceId),
        nameTaken,
        season: SEASON,
      });
      return;
    }

    res.status(405).json({ error: "method" });
  } catch (err) {
    const mem = getMem();
    res.status(500).json({
      error: "server",
      scores: mem.scores || [],
      me: null,
      season: SEASON,
    });
  }
};
