// Service Worker — caches app shell for instant repeat loads
// Version is updated by the server via query param on registration

const CACHE_NAME = 'xbox-v5';

// App shell — only the root document is precached (offline fallback for the
// HTML network-first path below). Static assets are NOT precached: the page
// references them exclusively through versioned ?v=<mtime> URLs and the fetch
// handler matches with the query string, so unversioned precache entries could
// never be served — they were ~600 KB downloaded twice on every install for
// zero hits. The cache-first runtime path below populates versioned assets on
// first real use instead.
const APP_SHELL = ['/'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Skip non-GET, API calls, and cross-origin requests
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.origin !== self.location.origin) return;

  // /img is the image proxy. Responses are already served with
  // Cache-Control: immutable + 1-year max-age, so the browser HTTP cache
  // covers it. Intercepting in the SW adds nothing — and the proxy may
  // return a placeholder on upstream errors that we don't want pinned in
  // CacheStorage. Let it pass straight through.
  if (url.pathname === '/img') return;

  // htmx SPA navigations must always hit the network — never serve stale cache.
  // htmx sends Accept: */* (not text/html), so the HTML block below won't match.
  if (e.request.headers.get('HX-Request') === 'true') return;

  // Static assets with ?v= — cache-first (immutable, versioned).
  // Before storing a new version, evict superseded ?v= entries for the same
  // pathname: each deploy mints fresh mtime versions, and without eviction
  // every old bundle/font/script accumulates in CacheStorage forever (the
  // activate handler only clears on manual CACHE_NAME bumps).
  if (url.pathname.startsWith('/static/') && url.searchParams.has('v')) {
    e.respondWith(
      caches.match(e.request, { ignoreSearch: false }).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(resp => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then(c =>
              c.keys(e.request, { ignoreSearch: true })
                .then(old => Promise.all(old.map(k => c.delete(k))))
                .then(() => c.put(e.request, clone))
            );
          }
          return resp;
        });
      })
    );
    return;
  }

  // HTML pages — network-first, fall back to cache
  // Skip caching for htmx SPA partial requests (they return fragments, not full pages)
  if (e.request.headers.get('accept')?.includes('text/html')) {
    const isHtmx = e.request.headers.get('HX-Request') === 'true';
    if (isHtmx) {
      // Let htmx requests pass through to the network without caching
      return;
    }
    e.respondWith(
      fetch(e.request)
        .then(resp => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          }
          return resp;
        })
        // If fetch fails AND there's no cached fallback, re-throw so the
        // browser surfaces the real error (AbortError on nav teardown is
        // silenced; genuine network errors show their actual type). Never
        // synthesize a 504 — it produces a misleading "offline" console line.
        .catch(err => caches.match(e.request).then(c => { if (c) return c; throw err; }))
    );
    return;
  }

  // Everything else — stale-while-revalidate
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetched = fetch(e.request).then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return resp;
      }).catch(err => {
        // Prefer stale cache over a network error. If neither, re-throw —
        // respondWith() resolves the rejection as a normal network failure
        // (AbortError from htmx teardown is silenced; real failures show
        // their actual error type instead of a synthetic 504/offline).
        if (cached) return cached;
        throw err;
      });
      return cached || fetched;
    })
  );
});
