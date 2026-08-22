/**
 * =====================================================================
 * sw.js - Service Worker MotoGPS (Mode Hors-Ligne & Cache Tuiles Cartographiques)
 * =====================================================================
 * Gère la mise en cache de la coquille applicative (App Shell) et le
 * stockage dynamique / par lot des tuiles OpenStreetMap pour une
 * navigation 100% autonome sans connexion 4G/5G en rase campagne.
 * =====================================================================
 */

const CACHE_APP_SHELL = 'motogps-shell-v1';
const CACHE_TILES = 'motogps-tiles-v1';

// Fichiers vitaux de l'application
const APP_SHELL_FILES = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './geo-math.js',
    './manifest.json',
    './icon.svg',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

/**
 * 1. Installation du Service Worker : Mise en cache de l'App Shell
 */
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_APP_SHELL).then(async (cache) => {
            console.log('[Service Worker] Mise en cache de l\'App Shell...');
            // Mise en cache tolérante aux erreurs pour les CDN distants
            for (const url of APP_SHELL_FILES) {
                try {
                    await cache.add(new Request(url, { cache: 'reload' }));
                } catch (err) {
                    console.warn(`[Service Worker] Échec mise en cache initiale pour : ${url}`, err);
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
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_APP_SHELL && cacheName !== CACHE_TILES) {
                        console.log(`[Service Worker] Suppression de l'ancien cache : ${cacheName}`);
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

/**
 * 3. Interception des requêtes réseau (Fetch)
 * Stratégie 'Cache First' pour les tuiles et l'App Shell
 */
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // A. Interception des tuiles de carte OpenStreetMap (tile.openstreetmap.org)
    if (url.hostname.includes('tile.openstreetmap.org') || url.pathname.match(/\/\d+\/\d+\/\d+\.png$/)) {
        event.respondWith(
            caches.open(CACHE_TILES).then(async (tileCache) => {
                const cachedResponse = await tileCache.match(event.request);
                if (cachedResponse) {
                    return cachedResponse;
                }

                // Si pas dans le cache, téléchargement réseau et mise en cache automatique
                try {
                    const networkResponse = await fetch(event.request);
                    if (networkResponse && networkResponse.status === 200) {
                        tileCache.put(event.request, networkResponse.clone());
                    }
                    return networkResponse;
                } catch (networkError) {
                    // Si hors-ligne et tuile non présente, renvoyer une tuile transparente vide
                    return new Response('', { status: 408, statusText: 'Offline Tile Unavailable' });
                }
            })
        );
        return;
    }

    // B. Interception des assets de l'App Shell (CSS, JS, Fonts, CDN)
    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            if (cachedResponse) {
                // Stratégie Stale-While-Revalidate en tâche de fond pour mettre à jour les assets
                fetch(event.request).then((networkResponse) => {
                    if (networkResponse && networkResponse.status === 200) {
                        caches.open(CACHE_APP_SHELL).then((cache) => {
                            cache.put(event.request, networkResponse);
                        });
                    }
                }).catch(() => {/* Mode hors ligne silencieux */});

                return cachedResponse;
            }

            return fetch(event.request).then((networkResponse) => {
                if (networkResponse && networkResponse.status === 200 && event.request.method === 'GET') {
                    const cloned = networkResponse.clone();
                    caches.open(CACHE_APP_SHELL).then((cache) => {
                        cache.put(event.request, cloned);
                    });
                }
                return networkResponse;
            }).catch(() => {
                // Si la page HTML principale est demandée hors-ligne
                if (event.request.headers.get('accept')?.includes('text/html')) {
                    return caches.match('./index.html');
                }
            });
        })
    );
});

/**
 * 4. Communication avec le Thread Principal (app.js)
 * Téléchargement massif et ordonné des tuiles de la trace GPX
 */
self.addEventListener('message', async (event) => {
    const data = event.data;
    if (!data) return;

    if (data.type === 'START_TILE_DOWNLOAD') {
        const tileUrls = data.tileUrls || [];
        const total = tileUrls.length;
        let downloaded = 0;
        let errors = 0;

        console.log(`[Service Worker] Démarrage du préchargement de ${total} tuiles...`);

        const tileCache = await caches.open(CACHE_TILES);
        const BATCH_SIZE = 6; // Téléchargement par paquet pour respecter les serveurs OSM

        for (let i = 0; i < total; i += BATCH_SIZE) {
            const batch = tileUrls.slice(i, i + BATCH_SIZE);

            await Promise.all(batch.map(async (url) => {
                try {
                    const match = await tileCache.match(url);
                    if (!match) {
                        const response = await fetch(url, { mode: 'cors' });
                        if (response.ok) {
                            await tileCache.put(url, response);
                        } else {
                            errors++;
                        }
                    }
                    downloaded++;
                } catch (e) {
                    errors++;
                    downloaded++;
                }
            }));

            // Notifier l'application de la progression
            const clients = await self.clients.matchAll();
            clients.forEach((client) => {
                client.postMessage({
                    type: 'TILE_DOWNLOAD_PROGRESS',
                    downloaded: downloaded,
                    total: total,
                    percentage: Math.round((downloaded / total) * 100),
                    errors: errors
                });
            });
        }

        // Notification de fin
        const clients = await self.clients.matchAll();
        clients.forEach((client) => {
            client.postMessage({
                type: 'TILE_DOWNLOAD_COMPLETE',
                total: total,
                downloaded: downloaded,
                errors: errors
            });
        });

        console.log(`[Service Worker] Téléchargement terminé : ${downloaded}/${total} tuiles traitées.`);
    }
});
