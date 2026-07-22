// Offline support: the app shell and CDN libraries are cached so the journal
// opens without a network. Data calls (Supabase, /api) are never cached.
const CACHE = "journal-v5";
const PRECACHE = ["/", "/index.html", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // live data must never come from cache
  if (url.hostname.includes("supabase") || url.pathname.startsWith("/api/")) return;

  // navigations: freshest app when online, cached shell when offline
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const cp = res.clone();
          caches.open(CACHE).then((c) => c.put("/index.html", cp));
          return res;
        })
        .catch(() => caches.match("/index.html"))
    );
    return;
  }

  // static assets + CDN libraries: cache-first, refresh in the background
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res && (res.ok || res.type === "opaque")) {
            const cp = res.clone();
            caches.open(CACHE).then((c) => c.put(req, cp));
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
