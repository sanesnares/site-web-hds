/**
 * Classement partagé 92 Rush — merge gossip + identité IP.
 * GET  → { scores, me: { name, entry } | null }
 * POST → body { scores, name? } → merge + lie le pseudo à l’IP → { scores, me }
 *
 * L’IP est stockée en hash (jamais en clair). Les entrées portent `hid`
 * pour reconstruire le lien IP ↔ pseudo même après un cold start (gossip).
 */

const crypto = require("crypto");

const MAX = 40;
const BLOB_PATHNAME = "hds92-leaderboard.json";

function rank(a, b) {
  if (!!a.win !== !!b.win) return a.win ? -1 : 1;
  if (a.win && b.win) return (a.timeMs | 0) - (b.timeMs | 0);
  if ((a.meters | 0) !== (b.meters | 0)) return (b.meters | 0) - (a.meters | 0);
  if ((a.cams | 0) !== (b.cams | 0)) return (b.cams | 0) - (a.cams | 0);
  return (a.timeMs | 0) - (b.timeMs | 0);
}

function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.trim()) return xf.split(",")[0].trim();
  if (Array.isArray(xf) && xf[0]) return String(xf[0]).split(",")[0].trim();
  const real = req.headers["x-real-ip"];
  if (real) return String(real).trim();
  return String((req.socket && req.socket.remoteAddress) || "").trim();
}

function ipHash(ip) {
  if (!ip) return "";
  const salt = process.env.HDS92_IP_SALT || "hds92-rush-92";
  return crypto.createHash("sha256").update(salt + "|" + ip).digest("hex").slice(0, 32);
}

function cleanEntry(e) {
  if (!e || typeof e !== "object") return null;
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
  const hid = String(e.hid || "").replace(/[^a-f0-9]/gi, "").slice(0, 32);
  const out = { id, name, timeMs, meters, cams, win, at };
  if (hid) out.hid = hid.toLowerCase();
  return out;
}

function mergeBoards(a, b) {
  const byName = new Map();
  for (const raw of [].concat(a || [], b || [])) {
    const e = cleanEntry(raw);
    if (!e) continue;
    const key = e.name.toLowerCase();
    const prev = byName.get(key);
    if (!prev || rank(e, prev) < 0) {
      byName.set(key, e);
    } else if (prev && e.hid && !prev.hid) {
      prev.hid = e.hid;
      byName.set(key, prev);
    }
  }
  return Array.from(byName.values()).sort(rank).slice(0, MAX);
}

function getMem() {
  if (!globalThis.__HDS92_STORE) {
    globalThis.__HDS92_STORE = { scores: [], players: Object.create(null) };
  }
  return globalThis.__HDS92_STORE;
}

function rebuildPlayersFromScores(scores, players) {
  const map = players && typeof players === "object" ? { ...players } : Object.create(null);
  for (const e of scores || []) {
    if (!e || !e.hid || !e.name) continue;
    const prev = map[e.hid];
    if (!prev || (e.at | 0) >= (prev.at | 0)) {
      map[e.hid] = { name: e.name, at: e.at | 0 || Date.now() };
    }
  }
  return map;
}

async function loadPersist() {
  const mem = getMem();
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return mem;
  if (mem._loaded) return mem;
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
      const scores = mergeBoards(data.scores || [], mem.scores || []);
      const players = rebuildPlayersFromScores(scores, data.players || mem.players);
      mem.scores = scores;
      mem.players = players;
    }
  } catch (_) {}
  mem._loaded = true;
  return mem;
}

let persistTimer = null;
function schedulePersist(mem) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const body = JSON.stringify({
      scores: mem.scores || [],
      players: mem.players || {},
      at: Date.now(),
    });
    fetch("https://blob.vercel-storage.com/" + BLOB_PATHNAME, {
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
    }).catch(() => {});
  }, 250);
}

function resolveMe(mem, hid) {
  if (!hid) return null;
  const bind = mem.players && mem.players[hid];
  let name = bind && bind.name ? String(bind.name) : "";
  if (!name) {
    const hit = (mem.scores || []).find((e) => e && e.hid === hid);
    if (hit) name = hit.name;
  }
  if (!name) return null;
  const entry =
    (mem.scores || []).find((e) => e.name.toLowerCase() === name.toLowerCase()) || null;
  return { name, entry };
}

function bindPlayer(mem, hid, name) {
  if (!hid || !name) return;
  mem.players[hid] = { name, at: Date.now() };
  // Tamponne le hash IP sur l’entrée du pseudo (pour gossip / cold start)
  const key = name.toLowerCase();
  mem.scores = (mem.scores || []).map((e) => {
    if (e.name.toLowerCase() !== key) return e;
    return { ...e, hid };
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  try {
    const mem = await loadPersist();
    const hid = ipHash(clientIp(req));

    if (req.method === "GET") {
      mem.players = rebuildPlayersFromScores(mem.scores, mem.players);
      res.status(200).json({ scores: mem.scores || [], me: resolveMe(mem, hid) });
      return;
    }

    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch (_) { body = {}; }
      }
      const incoming = (body && body.scores) || [];
      const claimName = String((body && body.name) || "")
        .trim()
        .slice(0, 20)
        .replace(/[<>&"']/g, "");

      // Les scores envoyés par ce client héritent du hash IP si c’est son pseudo
      const stamped = (Array.isArray(incoming) ? incoming : []).map((raw) => {
        const e = cleanEntry(raw);
        if (!e) return null;
        if (hid && claimName && e.name.toLowerCase() === claimName.toLowerCase()) {
          e.hid = hid;
        }
        return e;
      }).filter(Boolean);

      mem.scores = mergeBoards(mem.scores, stamped);
      if (hid && claimName) bindPlayer(mem, hid, claimName);
      mem.players = rebuildPlayersFromScores(mem.scores, mem.players);
      schedulePersist(mem);

      res.status(200).json({ scores: mem.scores, me: resolveMe(mem, hid) });
      return;
    }

    res.status(405).json({ error: "method" });
  } catch (err) {
    const mem = getMem();
    res.status(500).json({ error: "server", scores: mem.scores || [], me: null });
  }
};
