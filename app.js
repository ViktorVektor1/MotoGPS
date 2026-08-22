/**
 * =====================================================================
 * app.js - Logique Principale de l'Application MotoGPS PWA
 * =====================================================================
 * Gère l'initialisation Leaflet, la géolocalisation haute précision,
 * le cap compas/vitesse, l'anticipation des virages en temps réel,
 * le Screen Wake Lock et la mise en cache hors-ligne des tuiles.
 * =====================================================================
 */

(function () {
    'use strict';

    // Coordonnées par défaut : Noisy-le-Grand, France
    const DEFAULT_COORDS = [48.8398, 2.5539];
    const DEFAULT_ZOOM = 16;

    // État global de l'application
    const state = {
        map: null,
        userMarker: null,
        accuracyCircle: null,
        markerElement: null,
        currentPos: { lat: DEFAULT_COORDS[0], lon: DEFAULT_COORDS[1] },
        previousPos: null,
        heading: 0,
        speedKmh: 0,
        isFollowing: true,
        wakeLock: null,
        trackPoints: [], // Points de la trace GPX [{lat, lon, ele, time}]
        trackGlowLayer: null,
        trackMainLayer: null,
        lastClosestSegmentIndex: 0,
        lastZoomChangeTime: 0,
        activeTilesToDownload: [],
        isDownloadingTiles: false
    };

    // Éléments du DOM
    const dom = {
        map: document.getElementById('map'),
        speedValue: document.getElementById('speedValue'),
        turnCard: document.getElementById('turnCard'),
        turnIconBox: document.getElementById('turnIconBox'),
        turnDistance: document.getElementById('turnDistance'),
        turnTitle: document.getElementById('turnTitle'),
        turnSubtitle: document.getElementById('turnSubtitle'),
        gpsDot: document.getElementById('gpsDot'),
        gpsText: document.getElementById('gpsText'),
        wakeLockDot: document.getElementById('wakeLockDot'),
        zoomValue: document.getElementById('zoomValue'),
        btnRecenter: document.getElementById('btnRecenter'),
        btnGpx: document.getElementById('btnGpx'),
        gpxFileInput: document.getElementById('gpxFileInput'),
        btnOffline: document.getElementById('btnOffline'),
        btnMapStyle: document.getElementById('btnMapStyle'),
        offlineModal: document.getElementById('offlineModal'),
        modalDescription: document.getElementById('modalDescription'),
        progressBar: document.getElementById('progressBar'),
        progressText: document.getElementById('progressText'),
        tileCountStat: document.getElementById('tileCountStat'),
        tileErrorStat: document.getElementById('tileErrorStat'),
        btnConfirmDownload: document.getElementById('btnConfirmDownload'),
        btnCancelModal: document.getElementById('btnCancelModal'),
        toastMsg: document.getElementById('toastMsg')
    };

    // =========================================================================
    // 1. INITIALISATION DE LA CARTE LEAFLET
    // =========================================================================
    function initMap() {
        state.map = L.map('map', {
            center: DEFAULT_COORDS,
            zoom: DEFAULT_ZOOM,
            zoomControl: false, // Pas de boutons +/- pour épurer l'interface moto
            attributionControl: false,
            preferCanvas: true
        });

        // Fond de carte OpenStreetMap Standard (avec filtre sombre CSS)
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            subdomains: ['a', 'b', 'c']
        }).addTo(state.map);

        // Création de l'icône de position Moto personnalisée (Flèche directionnelle tournante)
        const motoIcon = L.divIcon({
            className: 'moto-custom-icon',
            html: `
                <div class="moto-marker-container">
                    <div class="moto-marker-halo"></div>
                    <div class="moto-marker-arrow" id="motoArrow">
                        <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <polygon points="50,10 88,85 50,68 12,85" fill="#00f0ff" stroke="#ffffff" stroke-width="4" stroke-linejoin="round" />
                            <circle cx="50" cy="55" r="7" fill="#ffffff" />
                        </svg>
                    </div>
                </div>
            `,
            iconSize: [64, 64],
            iconAnchor: [32, 32]
        });

        // Marqueur de position
        state.userMarker = L.marker(DEFAULT_COORDS, {
            icon: motoIcon,
            zIndexOffset: 1000
        }).addTo(state.map);

        // Cercle d'incertitude GPS
        state.accuracyCircle = L.circle(DEFAULT_COORDS, {
            radius: 15,
            color: '#00f0ff',
            weight: 1,
            fillColor: '#00f0ff',
            fillOpacity: 0.15
        }).addTo(state.map);

        // Référence sur l'élément HTML de la flèche pour les rotations CSS
        setTimeout(() => {
            state.markerElement = document.getElementById('motoArrow');
        }, 100);

        // Détection du déplacement manuel de la carte par l'utilisateur (désactive le mode suivi)
        state.map.on('dragstart', () => {
            setFollowMode(false);
        });

        // Mise à jour de l'indicateur de zoom dans le HUD
        state.map.on('zoomend', () => {
            if (dom.zoomValue) {
                dom.zoomValue.textContent = Math.round(state.map.getZoom());
            }
        });
    }

    // =========================================================================
    // 2. GÉOLOCALISATION HAUTE PRÉCISION & VITESSE
    // =========================================================================
    function initGeolocation() {
        if (!('geolocation' in navigator)) {
            showToast('Erreur : Géolocalisation non supportée');
            dom.gpsText.textContent = 'GPS ABSENT';
            return;
        }

        const geoOptions = {
            enableHighAccuracy: true, // Force le chipset GPS plutôt que le Wi-Fi/cellulaire
            maximumAge: 500,          // Données fraîches
            timeout: 10000
        };

        navigator.geolocation.watchPosition(onLocationSuccess, onLocationError, geoOptions);

        // Capteurs d'orientation du téléphone (secours si GPS à l'arrêt)
        if (window.DeviceOrientationEvent) {
            window.addEventListener('deviceorientationabsolute', handleOrientation, true);
            window.addEventListener('deviceorientation', handleOrientation, true);
        }
    }

    function onLocationSuccess(position) {
        const coords = position.coords;
        const newLat = coords.latitude;
        const newLon = coords.longitude;
        const accuracy = coords.accuracy || 10;

        // Mise à jour de l'état GPS
        dom.gpsDot.classList.add('active');
        dom.gpsText.textContent = `GPS (±${Math.round(accuracy)}m)`;

        // Vitesse instantanée : conversion m/s -> km/h
        let speed = (coords.speed !== null && !isNaN(coords.speed) && coords.speed >= 0)
            ? Math.round(coords.speed * 3.6)
            : 0;

        state.speedKmh = speed;
        dom.speedValue.textContent = speed;

        // Calcul ou récupération du Cap (Heading)
        let heading = coords.heading;
        if (heading === null || isNaN(heading)) {
            // Si le GPS ne fournit pas le cap (arrêt ou smartphone), calculer entre les deux derniers points
            if (state.previousPos && speed >= 3) {
                const dist = GeoMath.haversineDistance(state.previousPos.lat, state.previousPos.lon, newLat, newLon);
                if (dist > 2.0) {
                    heading = GeoMath.calculateBearing(state.previousPos.lat, state.previousPos.lon, newLat, newLon);
                }
            }
        }

        if (heading !== null && !isNaN(heading)) {
            state.heading = GeoMath.normalizeAngle(heading);
            updateMarkerRotation(state.heading);
        }

        // Sauvegarde de la position précédente
        state.previousPos = { ...state.currentPos };
        state.currentPos = { lat: newLat, lon: newLon };

        // Déplacement du marqueur et du cercle de précision
        const latLng = [newLat, newLon];
        state.userMarker.setLatLng(latLng);
        state.accuracyCircle.setLatLng(latLng);
        state.accuracyCircle.setRadius(accuracy);

        // Centrage fluide de la carte si le mode suivi est actif
        if (state.isFollowing) {
            state.map.panTo(latLng, { animate: true, duration: 0.5 });
        }

        // Exécution de l'anticipation de virage si une trace GPX est active
        if (state.trackPoints.length >= 2) {
            processTurnAnticipation();
        }
    }

    function onLocationError(error) {
        console.warn('[GPS] Erreur de géolocalisation :', error.message);
        dom.gpsDot.classList.remove('active');
        dom.gpsText.textContent = 'GPS PERDU';
    }

    function handleOrientation(event) {
        // Utilisé seulement si la moto est à l'arrêt (vitesse < 3 km/h)
        if (state.speedKmh < 3) {
            let heading = event.webkitCompassHeading || (event.alpha ? 360 - event.alpha : null);
            if (heading !== null && !isNaN(heading)) {
                state.heading = GeoMath.normalizeAngle(heading);
                updateMarkerRotation(state.heading);
            }
        }
    }

    function updateMarkerRotation(deg) {
        if (!state.markerElement) {
            state.markerElement = document.getElementById('motoArrow');
        }
        if (state.markerElement) {
            state.markerElement.style.transform = `rotate(${deg}deg)`;
        }
    }

    // =========================================================================
    // 3. MAINTIEN DE L'ÉCRAN ACTIF (SCREEN WAKE LOCK API)
    // =========================================================================
    async function requestWakeLock() {
        if ('wakeLock' in navigator) {
            try {
                state.wakeLock = await navigator.wakeLock.request('screen');
                dom.wakeLockDot.classList.add('active');
                console.log('[WakeLock] Maintien actif de l\'écran activé.');

                state.wakeLock.addEventListener('release', () => {
                    dom.wakeLockDot.classList.remove('active');
                    console.log('[WakeLock] Verrou d\'écran libéré.');
                });
            } catch (err) {
                console.warn(`[WakeLock] Échec de demande : ${err.name}, ${err.message}`);
                dom.wakeLockDot.classList.remove('active');
            }
        } else {
            console.warn('[WakeLock] API non supportée sur ce navigateur.');
            dom.wakeLockDot.classList.remove('active');
        }
    }

    // Réactivation automatique si l'utilisateur change d'application et revient
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            requestWakeLock();
        }
    });

    // =========================================================================
    // 4. MOTEUR GPX (PARSER NÉON HAUTE VISIBILITÉ)
    // =========================================================================
    function initGpxLoader() {
        dom.btnGpx.addEventListener('click', () => {
            dom.gpxFileInput.click();
        });

        dom.gpxFileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (evt) => {
                parseGpxContent(evt.target.result, file.name);
            };
            reader.readAsText(file);
        });
    }

    /**
     * Analyseur XML GPX natif ultra-rapide sans dépendance externe
     */
    function parseGpxContent(xmlText, fileName) {
        try {
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
            const trkpts = xmlDoc.querySelectorAll('trkpt, rtept');

            if (trkpts.length === 0) {
                showToast('Fichier GPX invalide ou sans points de trace');
                return;
            }

            const points = [];
            trkpts.forEach((pt) => {
                const lat = parseFloat(pt.getAttribute('lat'));
                const lon = parseFloat(pt.getAttribute('lon'));
                if (!isNaN(lat) && !isNaN(lon)) {
                    points.push({ lat, lon });
                }
            });

            if (points.length < 2) {
                showToast('Trace trop courte (< 2 points)');
                return;
            }

            state.trackPoints = points;
            state.lastClosestSegmentIndex = 0;

            // Rendu visuel de la trace en Néon Cyan & Magenta éclatant
            renderTrackOnMap(points);

            // Calcul de la distance totale
            let totalDistMeters = 0;
            for (let i = 0; i < points.length - 1; i++) {
                totalDistMeters += GeoMath.haversineDistance(points[i].lat, points[i].lon, points[i + 1].lat, points[i + 1].lon);
            }
            const distKm = (totalDistMeters / 1000).toFixed(1);

            showToast(`GPX chargé : ${distKm} km (${points.length} pts)`);
            dom.turnTitle.textContent = 'TRACE CHARGÉE';
            dom.turnSubtitle = `${distKm} km - En route !`;

        } catch (err) {
            console.error('[GPX] Erreur de parsing :', err);
            showToast('Erreur lors du décodage du fichier GPX');
        }
    }

    function renderTrackOnMap(points) {
        const latLngs = points.map(p => [p.lat, p.lon]);

        // Nettoyage des calques précédents
        if (state.trackGlowLayer) state.map.removeLayer(state.trackGlowLayer);
        if (state.trackMainLayer) state.map.removeLayer(state.trackMainLayer);

        // Halo Néon Extérieur (Cyan lumineux semi-transparent)
        state.trackGlowLayer = L.polyline(latLngs, {
            color: '#00f0ff',
            weight: 12,
            opacity: 0.4,
            lineCap: 'round',
            lineJoin: 'round'
        }).addTo(state.map);

        // Trait Principal Néon (Magenta très contrasté au cœur de la trace)
        state.trackMainLayer = L.polyline(latLngs, {
            color: '#ff007f',
            weight: 6,
            opacity: 1.0,
            lineCap: 'round',
            lineJoin: 'round'
        }).addTo(state.map);

        // Cadrer automatiquement la carte sur l'itinéraire
        const bounds = state.trackMainLayer.getBounds();
        state.map.fitBounds(bounds, { padding: [60, 60], maxZoom: 17 });
    }

    // =========================================================================
    // 5. ALGORITHME D'ANTICIPATION DE VIRAGE & ZOOM DYNAMIQUE
    // =========================================================================
    function processTurnAnticipation() {
        if (!state.trackPoints || state.trackPoints.length < 2) return;

        // Étape A : Recherche du segment le plus proche de la moto
        const closest = GeoMath.findClosestSegment(state.currentPos, state.trackPoints, state.lastClosestSegmentIndex);
        state.lastClosestSegmentIndex = closest.segmentIndex;

        // Si le motard est à plus de 150m de la trace (erreur de parcours)
        if (closest.distanceToTrack > 150) {
            dom.turnCard.className = 'turn-anticipation-card';
            dom.turnDistance.textContent = `${Math.round(closest.distanceToTrack)} m`;
            dom.turnTitle.textContent = 'HORS TRACE';
            dom.turnSubtitle.textContent = 'Rejoignez l\'itinéraire';
            renderTurnIcon('off-track');
            return;
        }

        // Étape B : Calcul de la distance d'anticipation dynamique (selon la vitesse)
        // À 100 km/h (~28 m/s), 3.5s d'anticipation = ~100m. À l'arrêt, 40m par défaut.
        const speedMs = (state.speedKmh || 0) / 3.6;
        const lookaheadHorizonSeconds = 3.5;
        const distanceAhead = Math.max(40, speedMs * lookaheadHorizonSeconds);

        // Recherche du point cible sur la trace GPX
        const target = GeoMath.getTargetPointAhead(state.trackPoints, closest.segmentIndex, closest.fraction, distanceAhead);

        // Étape C : Analyse de la courbure sur les 3 prochains segments
        const curvature = GeoMath.calculateCurvatureAhead(state.trackPoints, target.targetIndex, 3);

        // Étape D : Ajustement dynamique du zoom Leaflet (Anti-Désorientation)
        const optimalZoom = GeoMath.calculateDynamicZoom(state.speedKmh, curvature);
        const currentZoom = state.map.getZoom();
        const now = Date.now();

        // Limiter les changements de zoom (cooldown de 2 secondes pour fluidité)
        if (state.isFollowing && Math.abs(currentZoom - optimalZoom) >= 1 && (now - state.lastZoomChangeTime > 2000)) {
            state.lastZoomChangeTime = now;
            state.map.setZoom(optimalZoom, { animate: true });
        }

        // Mise à jour de l'affichage HUD de virage
        updateTurnHUD(target.actualDistanceMeters, curvature, optimalZoom);
    }

    function updateTurnHUD(distanceMeters, curvature, zoom) {
        dom.turnDistance.textContent = `${Math.round(distanceMeters)} m`;
        dom.turnCard.className = 'turn-anticipation-card';

        let iconType = 'straight';
        let title = 'LIGNE DROITE';

        if (curvature.severity === 'hairpin') {
            dom.turnCard.classList.add('hairpin');
            title = curvature.turnDirection === 'left' ? 'ÉPINGLE GAUCHE' : 'ÉPINGLE DROITE';
            iconType = curvature.turnDirection === 'left' ? 'hairpin-left' : 'hairpin-right';
        } else if (curvature.severity === 'sharp') {
            dom.turnCard.classList.add('sharp');
            title = curvature.turnDirection === 'left' ? 'VIRAGE SERRÉ G.' : 'VIRAGE SERRÉ D.';
            iconType = curvature.turnDirection === 'left' ? 'sharp-left' : 'sharp-right';
        } else if (curvature.severity === 'moderate') {
            title = curvature.turnDirection === 'left' ? 'VIRAGE GAUCHE' : 'VIRAGE DROITE';
            iconType = curvature.turnDirection === 'left' ? 'turn-left' : 'turn-right';
        } else if (curvature.severity === 'slight') {
            title = curvature.turnDirection === 'left' ? 'LÉGER GAUCHE' : 'LÉGER DROITE';
            iconType = curvature.turnDirection === 'left' ? 'slight-left' : 'slight-right';
        }

        dom.turnTitle.textContent = title;
        dom.turnSubtitle.textContent = `Courbure: ${curvature.cumulativeAngleDeg}° | Zoom: ${zoom}`;
        renderTurnIcon(iconType);
    }

    function renderTurnIcon(type) {
        let svgContent = '';

        switch (type) {
            case 'hairpin-left':
                svgContent = `<path d="M19 20V9a7 7 0 0 0-14 0v11" stroke="#ffe600" stroke-width="3.5" stroke-linecap="round" fill="none"/>
                              <polyline points="9 16 5 20 1 16" stroke="#ffe600" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
                break;
            case 'hairpin-right':
                svgContent = `<path d="M5 20V9a7 7 0 0 1 14 0v11" stroke="#ffe600" stroke-width="3.5" stroke-linecap="round" fill="none"/>
                              <polyline points="15 16 19 20 23 16" stroke="#ffe600" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
                break;
            case 'sharp-left':
                svgContent = `<path d="M18 19V9a4 4 0 0 0-4-4H5" stroke="#ffe600" stroke-width="3.5" stroke-linecap="round" fill="none"/>
                              <polyline points="9 1 4 6 9 11" stroke="#ffe600" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
                break;
            case 'sharp-right':
                svgContent = `<path d="M6 19V9a4 4 0 0 1 4-4h9" stroke="#ffe600" stroke-width="3.5" stroke-linecap="round" fill="none"/>
                              <polyline points="15 1 20 6 15 11" stroke="#ffe600" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
                break;
            case 'turn-left':
            case 'slight-left':
                svgContent = `<path d="M17 19a9 9 0 0 0-9-9H6" stroke="#00f0ff" stroke-width="3" stroke-linecap="round" fill="none"/>
                              <polyline points="10 6 6 10 10 14" stroke="#00f0ff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
                break;
            case 'turn-right':
            case 'slight-right':
                svgContent = `<path d="M7 19a9 9 0 0 1 9-9h2" stroke="#00f0ff" stroke-width="3" stroke-linecap="round" fill="none"/>
                              <polyline points="14 6 18 10 14 14" stroke="#00f0ff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
                break;
            case 'off-track':
                svgContent = `<line x1="18" y1="6" x2="6" y2="18" stroke="#ff3344" stroke-width="3.5" stroke-linecap="round"/>
                              <line x1="6" y1="6" x2="18" y2="18" stroke="#ff3344" stroke-width="3.5" stroke-linecap="round"/>`;
                break;
            default: // Tout droit
                svgContent = `<line x1="12" y1="19" x2="12" y2="5" stroke="#00ff66" stroke-width="3.5" stroke-linecap="round"/>
                              <polyline points="5 12 12 5 19 12" stroke="#00ff66" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
                break;
        }

        dom.turnIconBox.innerHTML = `
            <svg class="turn-icon-svg" viewBox="0 0 24 24" width="40" height="40">
                ${svgContent}
            </svg>
        `;
    }

    // =========================================================================
    // 6. GESTION DU MODE HORS-LIGNE & TÉLÉCHARGEMENT DES TUILES
    // =========================================================================
    function initOfflineManager() {
        dom.btnOffline.addEventListener('click', () => {
            prepareOfflineDownload();
        });

        dom.btnCancelModal.addEventListener('click', () => {
            dom.offlineModal.classList.remove('active');
        });

        dom.btnConfirmDownload.addEventListener('click', () => {
            startTileDownload();
        });

        // Écouter les messages de progression en provenance du Service Worker
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.addEventListener('message', (event) => {
                const data = event.data;
                if (!data) return;

                if (data.type === 'TILE_DOWNLOAD_PROGRESS') {
                    dom.progressBar.style.width = `${data.percentage}%`;
                    dom.progressText.textContent = `${data.percentage}%`;
                    dom.tileCountStat.textContent = `Tuiles : ${data.downloaded} / ${data.total}`;
                    dom.tileErrorStat.textContent = `Erreurs : ${data.errors || 0}`;
                } else if (data.type === 'TILE_DOWNLOAD_COMPLETE') {
                    dom.progressBar.style.width = '100%';
                    dom.progressText.textContent = '100%';
                    dom.btnConfirmDownload.disabled = false;
                    dom.btnConfirmDownload.textContent = 'Terminé ✓';
                    showToast('Carte hors-ligne prête pour l\'aventure !');
                }
            });
        }
    }

    function prepareOfflineDownload() {
        let bbox = null;

        if (state.trackPoints.length >= 2) {
            // Boîte englobante de la trace GPX
            let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
            state.trackPoints.forEach(p => {
                if (p.lat < minLat) minLat = p.lat;
                if (p.lat > maxLat) maxLat = p.lat;
                if (p.lon < minLon) minLon = p.lon;
                if (p.lon > maxLon) maxLon = p.lon;
            });
            bbox = { minLat, maxLat, minLon, maxLon };
        } else {
            // Boîte englobante de la vue actuelle de la carte
            const b = state.map.getBounds();
            bbox = {
                minLat: b.getSouth(),
                maxLat: b.getNorth(),
                minLon: b.getWest(),
                maxLon: b.getEast()
            };
        }

        // Calcul des tuiles pour les zooms 13 à 18
        const tiles = GeoMath.getTilesForBoundingBox(bbox, 13, 18);
        state.activeTilesToDownload = tiles;

        const totalTiles = tiles.length;
        const estimatedSizeMb = (totalTiles * 0.022).toFixed(1); // Moyenne ~22 Ko / tuile OSM

        dom.modalDescription.textContent = `Téléchargement de ${totalTiles} tuiles cartographiques (Zoom 13 à 18, ~${estimatedSizeMb} Mo) pour couvrir l'intégralité du trajet sans réseau mobile.`;
        dom.tileCountStat.textContent = `Tuiles : 0 / ${totalTiles}`;
        dom.tileErrorStat.textContent = 'Erreurs : 0';
        dom.progressBar.style.width = '0%';
        dom.progressText.textContent = '0%';
        dom.btnConfirmDownload.disabled = false;
        dom.btnConfirmDownload.textContent = 'Télécharger';

        dom.offlineModal.classList.add('active');
    }

    async function startTileDownload() {
        if (state.activeTilesToDownload.length === 0) return;

        dom.btnConfirmDownload.disabled = true;
        dom.btnConfirmDownload.textContent = 'Téléchargement...';

        const tileUrls = state.activeTilesToDownload.map(t => t.url);

        // Envoi au Service Worker s'il est actif
        if (navigator.serviceWorker && navigator.serviceWorker.controller) {
            navigator.serviceWorker.controller.postMessage({
                type: 'START_TILE_DOWNLOAD',
                tileUrls: tileUrls
            });
        } else {
            // Fallback direct via l'API Cache du navigateur
            await downloadTilesDirectly(tileUrls);
        }
    }

    async function downloadTilesDirectly(urls) {
        try {
            const cache = await caches.open('motogps-tiles-v1');
            const total = urls.length;
            let downloaded = 0;
            let errors = 0;
            const BATCH_SIZE = 6;

            for (let i = 0; i < total; i += BATCH_SIZE) {
                const batch = urls.slice(i, i + BATCH_SIZE);
                await Promise.all(batch.map(async (url) => {
                    try {
                        const match = await cache.match(url);
                        if (!match) {
                            const res = await fetch(url, { mode: 'cors' });
                            if (res.ok) await cache.put(url, res);
                            else errors++;
                        }
                    } catch (e) {
                        errors++;
                    }
                    downloaded++;
                }));

                const percent = Math.round((downloaded / total) * 100);
                dom.progressBar.style.width = `${percent}%`;
                dom.progressText.textContent = `${percent}%`;
                dom.tileCountStat.textContent = `Tuiles : ${downloaded} / ${total}`;
                dom.tileErrorStat.textContent = `Erreurs : ${errors}`;
            }

            dom.btnConfirmDownload.disabled = false;
            dom.btnConfirmDownload.textContent = 'Terminé ✓';
            showToast('Mise en cache hors-ligne terminée avec succès');
        } catch (err) {
            console.error('[Cache] Erreur lors du téléchargement direct :', err);
            showToast('Erreur durant le téléchargement hors-ligne');
            dom.btnConfirmDownload.disabled = false;
            dom.btnConfirmDownload.textContent = 'Réessayer';
        }
    }

    // =========================================================================
    // 7. CONTRÔLES UI & ERGONOMIE GANTS MOTO
    // =========================================================================
    function initUIControls() {
        // Bouton Centrage / Suivi
        dom.btnRecenter.addEventListener('click', () => {
            setFollowMode(true);
            state.map.panTo([state.currentPos.lat, state.currentPos.lon], { animate: true, duration: 0.6 });
        });

        // Bouton Inversion de Style de Carte (Sombre OLED / Clair)
        dom.btnMapStyle.addEventListener('click', () => {
            dom.map.classList.toggle('dark-tiles');
            const isDark = dom.map.classList.contains('dark-tiles');
            showToast(isDark ? 'Mode Carte : Sombre OLED' : 'Mode Carte : Standard');
        });
    }

    function setFollowMode(active) {
        state.isFollowing = active;
        if (active) {
            dom.btnRecenter.classList.add('following');
            dom.btnRecenter.querySelector('span').textContent = 'SUIVI';
        } else {
            dom.btnRecenter.classList.remove('following');
            dom.btnRecenter.querySelector('span').textContent = 'LIBRE';
        }
    }

    function showToast(message) {
        dom.toastMsg.textContent = message;
        dom.toastMsg.classList.add('show');
        setTimeout(() => {
            dom.toastMsg.classList.remove('show');
        }, 3200);
    }

    // =========================================================================
    // 8. ENREGISTREMENT DU SERVICE WORKER & DÉMARRAGE
    // =========================================================================
    function registerServiceWorker() {
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('./sw.js')
                    .then((reg) => console.log('[Service Worker] Enregistré avec succès :', reg.scope))
                    .catch((err) => console.warn('[Service Worker] Échec d\'enregistrement :', err));
            });
        }
    }

    // Point d'entrée de l'application
    document.addEventListener('DOMContentLoaded', () => {
        initMap();
        initGeolocation();
        initGpxLoader();
        initOfflineManager();
        initUIControls();
        requestWakeLock();
        registerServiceWorker();
    });

})();
