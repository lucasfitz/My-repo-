// Sprout service worker — offline-first app shell cache.
const CACHE = "sprout-v21";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./plants-data.js",
  "./weather.js",
  "./ai.js",
  "./species-photos.js",
  "./sync.js",
  "./calendar.js",
  "./vendor/supabase.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  // Cross-origin (weather API, Supabase sync) goes straight to the network —
  // those callers handle their own caching and offline fallbacks.
  if (new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then(cached =>
      cached ||
      fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
    )
  );
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: "window" }).then(list => {
    if (list.length) return list[0].focus();
    return clients.openWindow("./#/today");
  }));
});
