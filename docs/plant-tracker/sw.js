// Sprout service worker — offline-first app shell cache.
const VERSION = "sprout-v33";
const CACHE = VERSION;
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

self.addEventListener("message", e => {
  if (e.data === "version") {
    const reply = { type: "version", version: VERSION };
    // Reply down the port when the caller opened one, otherwise to the client.
    if (e.ports && e.ports[0]) e.ports[0].postMessage(reply);
    else e.source?.postMessage(reply);
  }
  if (e.data === "skipWaiting") self.skipWaiting();
});

// Icons never change without a filename change, so they can come straight from
// the cache. Everything else is the app itself: serve the network copy when
// there is one, because a stale app.js is indistinguishable from a broken
// deploy — you merge a change and the phone keeps showing you last week's app.
const isIcon = url => url.pathname.includes("/icons/");

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  // Cross-origin (weather API, Supabase sync) goes straight to the network —
  // those callers handle their own caching and offline fallbacks.
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  if (isIcon(url)) {
    e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request)));
    return;
  }

  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      // Offline, or the network failed: fall back to whatever was cached. A
      // navigation can fall back to the shell, since the router reads the hash.
      .catch(() => caches.match(e.request).then(cached =>
        cached || (e.request.mode === "navigate" ? caches.match("./index.html") : undefined)))
  );
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: "window" }).then(list => {
    if (list.length) return list[0].focus();
    return clients.openWindow("./#/today");
  }));
});
