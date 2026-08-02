/* Dimitry service worker — offline shell only.
   We deliberately do NOT cache market data or vault content:
   stale prices on a trading cockpit are dangerous. The shell loads
   offline; the live data always comes fresh from the network. */
const SHELL = "dimitry-shell-v1";

self.addEventListener("install", e => { self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks =>
    Promise.all(ks.filter(k => k !== SHELL).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  // never cache data or vault calls — always network, so prices are never stale
  if(url.pathname.startsWith("/api/") || url.hostname !== self.location.hostname){
    return; // let it hit the network normally
  }
  // network-first for the shell, fall back to cache when offline
  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(SHELL).then(c => c.put(e.request, copy)).catch(()=>{});
      return r;
    }).catch(() => caches.match(e.request))
  );
});
