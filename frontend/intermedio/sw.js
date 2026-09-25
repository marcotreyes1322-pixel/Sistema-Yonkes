// Service worker: makes the app installable and lets it open instantly (and
// show a friendly screen) even with a bad connection. Live data always comes
// from the WebSocket; only the static app shell is cached.
const CACHE = "intermedio-v1";
const SHELL = [
  "/intermedio/",
  "/intermedio/app.js",
  "/intermedio/manifest.webmanifest",
  "/shared/live.js",
  "/shared/styles.css",
  "/shared/icons/intermedio-192.png",
  "/shared/icons/intermedio-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("intermedio-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network-first: always get the latest version when online, cached copy when not.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("/intermedio/"))),
  );
});

// Tapping a notification brings the app to the front.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const win = wins.find((w) => new URL(w.url).pathname.startsWith("/intermedio/"));
      return win ? win.focus() : self.clients.openWindow("/intermedio/");
    }),
  );
});
