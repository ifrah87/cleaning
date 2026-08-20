// Cleaning Ops service worker.
//
// WHY THIS EXISTS
// The app already keeps the whole board in localStorage and can run from it when the
// server refuses — but that only helps while the PAGE still loads. With no network at
// all, index.html and the two libraries it pulls from a CDN never arrive, so there is
// nothing to run and the crew gets a blank screen. This caches the app itself, so it
// opens on a dead hotspot and falls straight through to the offline board.
//
// THE CACHING RULE, AND WHY IT IS THIS WAY ROUND
// index.html is NETWORK-FIRST. This app ships several times a day and the one screen
// nobody touches — the TV — already had a habit of running month-old code; a
// cache-first worker would make that permanent and much harder to notice. So the
// network always gets first refusal, and the cache is the fallback when it cannot
// answer. The two CDN libraries are cache-first because their URLs are version-pinned:
// a different version is a different URL, so a cached copy can never be stale.
const VERSION = 'v1';
const APP_CACHE = 'cleaning-app-' + VERSION;
const LIB_CACHE = 'cleaning-lib-' + VERSION;

const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

// Version-pinned, so a cached copy is always the right one.
const LIBS = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const app = await caches.open(APP_CACHE);
    // Individually, so one failure cannot abandon the whole install.
    await Promise.all(APP_SHELL.map((u) => app.add(u).catch(() => {})));
    const lib = await caches.open(LIB_CACHE);
    await Promise.all(LIBS.map((u) => lib.add(new Request(u, { mode: 'cors' })).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Drop caches from older versions, or an update leaves the old app behind it.
    const keep = [APP_CACHE, LIB_CACHE];
    for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // never cache a write
  const url = new URL(req.url);

  // The data layer is never cached. A cached board would be a lie told confidently,
  // and the app has its own copy in localStorage for exactly this purpose.
  if (url.hostname.endsWith('supabase.co')) return;

  if (LIBS.some((l) => req.url.startsWith(l.split('@2')[0]) && req.url.includes('cdn.jsdelivr.net'))) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        const c = await caches.open(LIB_CACHE);
        c.put(req, res.clone());
        return res;
      } catch (err) {
        return hit || Response.error();
      }
    })());
    return;
  }

  // Everything of ours — the page itself above all — asks the network first.
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          const c = await caches.open(APP_CACHE);
          c.put(req, res.clone());
        }
        return res;
      } catch (err) {
        const hit = await caches.match(req);
        if (hit) return hit;
        // A navigation with nothing cached still has to render something.
        if (req.mode === 'navigate') {
          const shell = await caches.match('/index.html');
          if (shell) return shell;
        }
        return Response.error();
      }
    })());
  }
});
