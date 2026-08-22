/**
 * =====================================================================
 * sw.js - Service Worker MotoGPS (Mode Hors-Ligne & Cache Tuiles CartoDB)
 * =====================================================================
 * Compatible avec l'hébergement en sous-dossier GitHub Pages (chemins relatifs).
 * Assure le fonctionnement autonome à 100% sans réseau mobile.
 * =====================================================================
 */

const CACHE_APP_SHELL = 'motogps-shell-v2';
const CACHE_TILES = 'motogps-tiles-v2';

// Chemins absolus pour GitHub Pages : viktorvektor1.github.io/MotoGPS/
const APP_SHELL_FILES = [
    '/MotoGPS/',
    '/MotoGPS/index.html',
    '/MotoGPS/style.css',
    '/MotoGPS/app.js',
    '/MotoGPS/geo-math.js',
    '/MotoGPS/manifest.json',
    '/MotoGPS/icon.svg',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

/**
 * 1. Installation du Service Worker : Mise en cache de l'App Shell
 */
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_APP_SHELL).then(async (cache) => {
            console.log('[SW] Pré-cache de l\'App Shell...');
            for (const url of APP_SHELL_FILES) {
                try {
                    await cache.add(new Request(url, { cache: 'reload' }));
                } catch (err) {
                    console.warn(`[SW] Échec mise en cache : ${url}`, err);
                }
            }
        }).then(() => self.skipWaiting())
    );
});

/**
 * 2. Activation : Nettoyage des anciennes versions de cache
 */
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((name) => {
                    if (name !== CACHE_APP_SHELL && name !== CACHE_TILES) {
                        console.log(`[SW] Suppression ancien cache : ${name}`);
                        return caches.delete(name);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

/**
 * 3. Interception des requêtes réseau (Fetch)
 * Stratégie 'Cache First' pour les tuiles cartographiques et l'App Shell
 */
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // A. Interception des tuiles de carte CartoDB Dark Matter / OSM
    if (url.hostname.includes('cartocdn.com') || url.hostname.includes('tile.openstreetmap.org') || url.pathname.match(/\/\d+\/\d+\/\d+(\.png|@[23]x\.png)?$/)) {
        event.respondWith(
            caches.open(CACHE_TILES).then(async (tileCache) => {
                const cachedResponse = await tileCache.match(event.request);
                if (cachedResponse) {
                    return cachedResponse;
                }

                try {
                    const networkResponse = await fetch(event.request);
                    if (networkResponse && networkResponse.status === 200) {
                        tileCache.put(event.request, networkResponse.clone());
                    }
                    return networkResponse;
                } catch (networkError) {
                    // Hors-ligne et tuile manquante : réponse vide propre
                    return new Response('', { status: 408, statusText: 'Offline Tile Unavailable' });
                }
            })
        );
        return;
    }

    // B. Interception des assets de l'App Shell
    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            if (cachedResponse) {
                // Revalidation en tâche de fond
                fetch(event.request).then((networkResponse) => {
                    if (networkResponse && networkResponse.status === 200) {
                        caches.open(CACHE_APP_SHELL).then((c) => c.put(event.request, networkResponse));
                    }
                }).catch(() => {});
                return cachedResponse;
            }

            return fetch(event.request).then((networkResponse) => {
                if (networkResponse && networkResponse.status === 200 && event.request.method === 'GET') {
                    const copy = networkResponse.clone();
                    caches.open(CACHE_APP_SHELL).then((c) => c.put(event.request, copy));
                }
                return networkResponse;
            }).catch(() => {
                if (event.request.headers.get('accept')?.includes('text/html')) {
                    return caches.match('/MotoGPS/index.html') || caches.match('/MotoGPS/');
                }
            });
        })
    );
});

/**
 * 4. Téléchargement par lot des tuiles GPX
 */
self.addEventListener('message', async (event) => {
    const data = event.data;
    if (!data) return;

    if (data.type === 'START_TILE_DOWNLOAD') {
        const tileUrls = data.tileUrls || [];
        const total = tileUrls.length;
        let downloaded = 0;
        let errors = 0;
        const BATCH_SIZE = 6;

        const tileCache = await caches.open(CACHE_TILES);

        for (let i = 0; i < total; i += BATCH_SIZE) {
            const batch = tileUrls.slice(i, i + BATCH_SIZE);

            await Promise.all(batch.map(async (url) => {
                try {
                    const exists = await tileCache.match(url);
                    if (!exists) {
                        const res = await fetch(url, { mode: 'cors' });
                        if (res.ok) await tileCache.put(url, res);
                        else errors++;
                    }
                    downloaded++;
                } catch (e) {
                    errors++;
                    downloaded++;
                }
            }));

            const clients = await self.clients.matchAll();
            clients.forEach((client) => {
                client.postMessage({
                    type: 'TILE_DOWNLOAD_PROGRESS',
                    downloaded,
                    total,
                    percentage: Math.round((downloaded / total) * 100),
                    errors
                });
            });
        }

        const clients = await self.clients.matchAll();
        clients.forEach((client) => {
            client.postMessage({
                type: 'TILE_DOWNLOAD_COMPLETE',
                total,
                downloaded,
                errors
            });
        });
    }
});
