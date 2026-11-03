// Service worker: network first, offline cache as fallback.
// Every request tries the network (revalidating with the server), so a visit always
// gets the latest files when online. The cache is only used offline or on a very
// slow connection, and is refreshed on demand by the page ('refresh' message).
// No version bump is needed for updates to reach players.
const CACHE = 'darts-cache';
const ASSETS = [
  './', 'style.css', 'board.js', 'game.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png',
];
const NET_TIMEOUT = 4000;

const keyFor = (url) => { const u = new URL(url, self.registration.scope); return u.origin + u.pathname; };

async function same(a, b) {
  const [x, y] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
  if (x.byteLength !== y.byteLength) return false;
  const p = new Uint8Array(x), q = new Uint8Array(y);
  for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return false;
  return true;
}

// Re-download every app file. full = bypass the browser's HTTP cache entirely.
// Resolves true if anything differed from the cached copy.
async function refresh(full) {
  const cache = await caches.open(CACHE);
  let changed = false;
  await Promise.all(ASSETS.map(async (path) => {
    const key = keyFor(path);
    const res = await fetch(key, { cache: full ? 'reload' : 'no-cache' });
    // Never cache redirects: a redirected response can't be served for navigation.
    if (!res.ok || res.redirected) throw new Error('Update failed for ' + path);
    const old = await cache.match(key);
    if (!old || !(await same(old, res.clone()))) { changed = true; await cache.put(key, res); }
  }));
  return changed;
}

async function notifyClients(msg) {
  const list = await self.clients.matchAll({ type: 'window' });
  for (const c of list) c.postMessage(msg);
}

self.addEventListener('install', (e) => {
  e.waitUntil(refresh(true).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type !== 'refresh') return;
  const port = e.ports && e.ports[0];
  e.waitUntil(refresh(!!d.full).then(
    (changed) => port && port.postMessage({ ok: true, changed }),
    () => port && port.postMessage({ ok: false })
  ));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const key = keyFor(req.url);

  const network = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
  const stored = network.then((res) => {
    if (res.ok && !res.redirected) {
      const copy = res.clone();
      return caches.open(CACHE).then((c) => c.put(key, copy));
    }
  }).catch(() => {});
  e.waitUntil(stored);

  e.respondWith((async () => {
    const timeout = new Promise((r) => setTimeout(r, NET_TIMEOUT, null));
    try {
      const res = await Promise.race([network, timeout]);
      if (res) return res;
    } catch (err) { /* offline: fall through to cache */ }
    const hit = (await caches.match(key)) || (req.mode === 'navigate' ? await caches.match(keyFor('./')) : null);
    if (!hit) return network;
    // Served from cache because the network was slow. If newer files then arrive,
    // tell the page so it can reload (it waits until the player is on the menu).
    const served = hit.clone();
    const check = network.then(async (res) => {
      if (res.ok && !res.redirected && !(await same(served, res.clone()))) await notifyClients({ type: 'updated' });
    }).catch(() => {});
    try { e.waitUntil(check); } catch (err) { /* event already settled (offline) */ }
    return hit;
  })());
});
