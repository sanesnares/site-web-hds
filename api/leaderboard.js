/**
 * Classement partagé 92 Rush — merge gossip (clients + mémoire instance).
 * GET  → { scores: Entry[] }
 * POST → body { scores: Entry[] } → merge → { scores }
 */

const MAX = 40;

function rank(a, b) {
  if (!!a.win !== !!b.win) return a.win ? -1 : 1;
  if (a.win && b.win) return (a.timeMs | 0) - (b.timeMs | 0);
  if ((a.meters | 0) !== (b.meters | 0)) return (b.meters | 0) - (a.meters | 0);
  if ((a.cams | 0) !== (b.cams | 0)) return (b.cams | 0) - (a.cams | 0);
  return (a.timeMs | 0) - (b.timeMs | 0);
}

function cleanEntry(e) {
  if (!e || typeof e !== "object") return null;
  const name = String(e.name || "")
    .trim()
    .slice(0, 16)
    .replace(/[<>&"']/g, "");
  if (!name) return null;
  const timeMs = Math.max(0, Math.min(9 * 3600 * 1000, e.timeMs | 0));
  const meters = Math.max(0, Math.min(5000, e.meters | 0));
  const cams = Math.max(0, Math.min(999, e.cams | 0));
  const win = !!e.win;
  const at = Math.max(0, e.at | 0) || Date.now();
  const id = String(e.id || name.toLowerCase() + "_" + at).slice(0, 64);
  return { id, name, timeMs, meters, cams, win, at };
}

function mergeBoards(a, b) {
  const byName = new Map();
  for (const raw of [].concat(a || [], b || [])) {
    const e = cleanEntry(raw);
    if (!e) continue;
    const key = e.name.toLowerCase();
    const prev = byName.get(key);
    if (!prev || rank(e, prev) < 0) byName.set(key, e);
  }
  return Array.from(byName.values()).sort(rank).slice(0, MAX);
}

function getStore() {
  if (!globalThis.__HDS92_BOARD) globalThis.__HDS92_BOARD = [];
  return globalThis.__HDS92_BOARD;
}

function setStore(scores) {
  globalThis.__HDS92_BOARD = scores;
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
    if (req.method === "GET") {
      res.status(200).json({ scores: getStore() });
      return;
    }
    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch (_) { body = {}; }
      }
      const incoming = (body && body.scores) || [];
      const merged = mergeBoards(getStore(), incoming);
      setStore(merged);
      res.status(200).json({ scores: merged });
      return;
    }
    res.status(405).json({ error: "method" });
  } catch (err) {
    res.status(500).json({ error: "server", scores: getStore() });
  }
};
