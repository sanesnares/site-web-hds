/* 92 Rush — service worker PWA */
const CACHE = "hds-rush-92-v25";
const SHELL = "./"; // la page du jeu (cleanUrls : /index.html redirige vers /)
const PRECACHE = [
  SHELL,
  "./manifest.json",
  "./assets/apple-touch-icon.png",
  "./assets/icon-192.png",
  "./assets/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // cache: "reload" → on ne précache jamais une vieille copie du cache HTTP
      .then((cache) => cache.addAll(PRECACHE.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isHtml(res) {
  return /text\/html/i.test(res.headers.get("content-type") || "");
}

function putInCache(req, res) {
  if (!res || !res.ok || res.status !== 200 || res.redirected) return;
  const copy = res.clone();
  caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.endsWith("/sw.js")) return;

  // Safari iOS utilise des requêtes Range (206 Partial Content) pour les sons
  if (req.headers.has("range")) {
    event.respondWith(
      fetch(req).catch(() => caches.match(req, { ignoreSearch: false }))
    );
    return;
  }

  // Page du jeu : réseau d’abord, copie hors ligne en secours
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req, { cache: "no-cache" })
        .then((res) => {
          // Seule la vraie page d’accueil devient la copie hors ligne
          if ((url.pathname === "/" || url.pathname === "/index.html") && isHtml(res)) {
            putInCache(SHELL, res);
          }
          return res;
        })
        .catch(() => caches.match(SHELL))
    );
    return;
  }

  // Images / sons : cache d’abord (les fichiers changent de nom quand ils changent)
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/sounds/")) {
    event.respondWith(
      caches.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req).then((res) => {
          putInCache(req, res);
          return res;
        });
      })
    );
    return;
  }

  // Le reste (manifest…) : cache puis mise à jour en arrière-plan
  event.respondWith(
    caches.match(req).then((hit) => {
      const fetched = fetch(req)
        .then((res) => {
          putInCache(req, res);
          return res;
        })
        .catch(() => hit);
      return hit || fetched;
    })
  );
});
