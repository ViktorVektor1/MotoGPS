/**
 * =====================================================================
 * app.js - Logique Principale MotoGPS (GitHub Pages & Design Mat Waze)
 * =====================================================================
 * Gère Leaflet (CartoDB Dark Matter), la géolocalisation haute précision,
 * le menu FAB escamotable, le Screen Wake Lock et le tracé GPX uni.
 * =====================================================================
 */

(function () {
    'use strict';

    // Position par défaut : Noisy-le-Grand, France
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
        trackPoints: [],
        trackCasingLayer: null,
        trackMainLayer: null,
        lastClosestSegmentIndex: 0,
        lastZoomChangeTime: 0,
        activeTilesToDownload: [],
        isMenuOpen: false
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
        fabContainer: document.getElementById('fabContainer'),
        fabTrigger: document.getElementById('fabTrigger'),
        menuBackdrop: document.getElementById('menuBackdrop'),
        btnRecenter: document.getElementById('btnRecenter'),
        btnGpx: document.getElementById('btnGpx'),
        gpxFileInput: document.getElementById('gpxFileInput'),
        btnOffline: document.getElementById('btnOffline'),
        offlineModal: document.getElementById('offlineModal'),
        modalDescription: document.getElementById('modalDescription'),
        progressBar: document.getElementById('progressBar'),
        progressText: document.getElementById('progressText'),
        tileCountStat: document.getElementById('tileCountStat'),
        btnConfirmDownload: document.getElementById('btnConfirmDownload'),
        btnCancelModal: document.getElementById('btnCancelModal'),
        toastMsg: document.getElementById('toastMsg'),
        themeToggle: document.getElementById('theme-toggle'),
        themeLabel: document.getElementById('theme-label'),
        themeIcon: document.getElementById('theme-icon')
    };

    // URLs des fonds de carte CartoDB
    const lightUrl = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
    const darkUrl = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';

    // =========================================================================
    // 1. INITIALISATION CARTE LEAFLET
    // =========================================================================
    function initMap() {
        // Lecture du thème sauvegardé ou clair par défaut
        const savedTheme = localStorage.getItem('theme') || 'light';
        if (savedTheme === 'dark') {
            document.body.classList.add('dark-theme');
        }
        updateThemeButtonUI(savedTheme);

        state.map = L.map('map', {
            center: DEFAULT_COORDS,
            zoom: DEFAULT_ZOOM,
            zoomControl: false,
            attributionControl: false,
            preferCanvas: true
        });

        // Initialisation de la couche de tuiles avec l'URL correspondant au thème
        const currentUrl = savedTheme === 'dark' ? darkUrl : lightUrl;
        state.tileLayer = L.tileLayer(currentUrl, {
            maxZoom: 19,
            subdomains: ['a', 'b', 'c', 'd']
        }).addTo(state.map);

        // Curseur de navigation moto minimaliste (Chevron bleu électrique)
        const motoIcon = L.divIcon({
            className: 'moto-custom-icon',
            html: `
                <div class="moto-marker-container">
                    <div class="moto-marker-arrow" id="motoArrow">
                        <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <polygon points="20,4 34,34 20,27 6,34" fill="#0A84FF" stroke="#FFFFFF" stroke-width="2.5" stroke-linejoin="round" />
                        </svg>
                    </div>
                </div>
            `,
            iconSize: [48, 48],
            iconAnchor: [24, 24]
        });

        state.userMarker = L.marker(DEFAULT_COORDS, {
            icon: motoIcon,
            zIndexOffset: 1000
        }).addTo(state.map);

        state.accuracyCircle = L.circle(DEFAULT_COORDS, {
            radius: 15,
            color: '#0A84FF',
            weight: 1,
            fillColor: '#0A84FF',
            fillOpacity: 0.12
        }).addTo(state.map);

        setTimeout(() => {
            state.markerElement = document.getElementById('motoArrow');
        }, 100);

        // Déplacement manuel : désactiver le mode centrage automatique
        state.map.on('dragstart', () => {
            setFollowMode(false);
            closeMenu();
        });

        state.map.on('click', () => {
            closeMenu();
        });

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
            showToast('GPS non supporté');
            dom.gpsText.textContent = 'GPS ABSENT';
            return;
        }

        const geoOptions = {
            enableHighAccuracy: true,
            maximumAge: 500,
            timeout: 10000
        };

        navigator.geolocation.watchPosition(onLocationSuccess, onLocationError, geoOptions);

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

        dom.gpsDot.classList.add('active');
        dom.gpsText.textContent = `GPS (±${Math.round(accuracy)}m)`;

        let speed = (coords.speed !== null && !isNaN(coords.speed) && coords.speed >= 0)
            ? Math.round(coords.speed * 3.6)
            : 0;

        state.speedKmh = speed;
        dom.speedValue.textContent = speed;

        let heading = coords.heading;
        if (heading === null || isNaN(heading)) {
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

        state.previousPos = { ...state.currentPos };
        state.currentPos = { lat: newLat, lon: newLon };

        const latLng = [newLat, newLon];
        state.userMarker.setLatLng(latLng);
        state.accuracyCircle.setLatLng(latLng);
        state.accuracyCircle.setRadius(accuracy);

        if (state.isFollowing) {
            state.map.panTo(latLng, { animate: true, duration: 0.5 });
        }

        if (state.trackPoints.length >= 2) {
            processTurnAnticipation();
        }
    }

    function onLocationError(error) {
        console.warn('[GPS] Erreur :', error.message);
        dom.gpsDot.classList.remove('active');
        dom.gpsText.textContent = 'GPS PERDU';
    }

    function handleOrientation(event) {
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
    // 3. MAINTIEN DE L'ÉCRAN ACTIF (SCREEN WAKE LOCK)
    // =========================================================================
    async function requestWakeLock() {
        if ('wakeLock' in navigator) {
            try {
                state.wakeLock = await navigator.wakeLock.request('screen');
                dom.wakeLockDot.classList.add('active');

                state.wakeLock.addEventListener('release', () => {
                    dom.wakeLockDot.classList.remove('active');
                });
            } catch (err) {
                console.warn(`[WakeLock] Échec : ${err.name}, ${err.message}`);
                dom.wakeLockDot.classList.remove('active');
            }
        }
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            requestWakeLock();
        }
    });

    // =========================================================================
    // 4. MOTEUR GPX (TRACÉ UNIFIÉ SANS DÉGRADÉ)
    // =========================================================================
    function initGpxLoader() {
        dom.btnGpx.addEventListener('click', () => {
            closeMenu();
            dom.gpxFileInput.click();
        });

        dom.gpxFileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (evt) => {
                parseGpxContent(evt.target.result);
            };
            reader.readAsText(file);
        });
    }

    function parseGpxContent(xmlText) {
        try {
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
            const trkpts = xmlDoc.querySelectorAll('trkpt, rtept');

            if (trkpts.length === 0) {
                showToast('Fichier GPX sans coordonnées');
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
                showToast('Tracé GPX trop court');
                return;
            }

            state.trackPoints = points;
            state.lastClosestSegmentIndex = 0;

            renderTrackOnMap(points);

            let totalDistMeters = 0;
            for (let i = 0; i < points.length - 1; i++) {
                totalDistMeters += GeoMath.haversineDistance(points[i].lat, points[i].lon, points[i + 1].lat, points[i + 1].lon);
            }
            const distKm = (totalDistMeters / 1000).toFixed(1);

            showToast(`GPX : ${distKm} km (${points.length} pts)`);
            dom.turnTitle.textContent = 'TRACÉ CHARGÉ';
            dom.turnSubtitle.textContent = `${distKm} km • Guidage actif`;

        } catch (err) {
            console.error('[GPX] Erreur :', err);
            showToast('Erreur décodage GPX');
        }
    }

    function renderTrackOnMap(points) {
        const latLngs = points.map(p => [p.lat, p.lon]);

        if (state.trackCasingLayer) state.map.removeLayer(state.trackCasingLayer);
        if (state.trackMainLayer) state.map.removeLayer(state.trackMainLayer);

        // Sous-couche de contraste noir mat
        state.trackCasingLayer = L.polyline(latLngs, {
            color: '#000000',
            weight: 8,
            opacity: 0.8,
            lineCap: 'round',
            lineJoin: 'round'
        }).addTo(state.map);

        // Ligne principale Bleu Électrique pur (épaisseur nette 4.5px)
        state.trackMainLayer = L.polyline(latLngs, {
            color: '#0A84FF',
            weight: 4.5,
            opacity: 1.0,
            lineCap: 'round',
            lineJoin: 'round'
        }).addTo(state.map);

        const bounds = state.trackMainLayer.getBounds();
        state.map.fitBounds(bounds, { padding: [50, 50], maxZoom: 17 });
    }

    // =========================================================================
    // 5. ANTICIPATION DE VIRAGE & ZOOM DYNAMIQUE
    // =========================================================================
    function processTurnAnticipation() {
        if (!state.trackPoints || state.trackPoints.length < 2) return;

        const closest = GeoMath.findClosestSegment(state.currentPos, state.trackPoints, state.lastClosestSegmentIndex);
        state.lastClosestSegmentIndex = closest.segmentIndex;

        // Hors trace (> 150m)
        if (closest.distanceToTrack > 150) {
            dom.turnCard.className = 'turn-banner';
            dom.turnDistance.textContent = `${Math.round(closest.distanceToTrack)} m`;
            dom.turnTitle.textContent = 'HORS TRACÉ';
            dom.turnSubtitle.textContent = 'Rejoignez l\'itinéraire';
            renderTurnIcon('off-track');
            return;
        }

        const speedMs = (state.speedKmh || 0) / 3.6;
        const distanceAhead = Math.max(40, speedMs * 3.5);

        const target = GeoMath.getTargetPointAhead(state.trackPoints, closest.segmentIndex, closest.fraction, distanceAhead);
        const curvature = GeoMath.calculateCurvatureAhead(state.trackPoints, target.targetIndex, 3);
        const optimalZoom = GeoMath.calculateDynamicZoom(state.speedKmh, curvature);

        const currentZoom = state.map.getZoom();
        const now = Date.now();

        if (state.isFollowing && Math.abs(currentZoom - optimalZoom) >= 1 && (now - state.lastZoomChangeTime > 2000)) {
            state.lastZoomChangeTime = now;
            state.map.setZoom(optimalZoom, { animate: true });
        }

        updateTurnHUD(target.actualDistanceMeters, curvature, optimalZoom);
    }

    function updateTurnHUD(distanceMeters, curvature, zoom) {
        dom.turnDistance.textContent = `${Math.round(distanceMeters)} m`;
        dom.turnCard.className = 'turn-banner';

        let iconType = 'straight';
        let title = 'LIGNE DROITE';

        if (curvature.severity === 'hairpin') {
            dom.turnCard.classList.add('hairpin');
            title = curvature.turnDirection === 'left' ? 'Épingle à gauche' : 'Épingle à droite';
            iconType = curvature.turnDirection === 'left' ? 'hairpin-left' : 'hairpin-right';
        } else if (curvature.severity === 'sharp') {
            dom.turnCard.classList.add('sharp');
            title = curvature.turnDirection === 'left' ? 'Virage serré gauche' : 'Virage serré droite';
            iconType = curvature.turnDirection === 'left' ? 'sharp-left' : 'sharp-right';
        } else if (curvature.severity === 'moderate') {
            title = curvature.turnDirection === 'left' ? 'Virage à gauche' : 'Virage à droite';
            iconType = curvature.turnDirection === 'left' ? 'turn-left' : 'turn-right';
        } else if (curvature.severity === 'slight') {
            title = curvature.turnDirection === 'left' ? 'Courbe légère gauche' : 'Courbe légère droite';
            iconType = curvature.turnDirection === 'left' ? 'slight-left' : 'slight-right';
        }

        dom.turnTitle.textContent = title;
        dom.turnSubtitle.textContent = `Angle ${curvature.cumulativeAngleDeg}° • Zoom auto ${zoom}`;
        renderTurnIcon(iconType);
    }

    function renderTurnIcon(type) {
        let svgContent = '';

        switch (type) {
            case 'hairpin-left':
                svgContent = `<path d="M19 20V9a7 7 0 0 0-14 0v11" stroke="#FF9F0A" stroke-width="2.8" stroke-linecap="round"/><polyline points="9 16 5 20 1 16" stroke="#FF9F0A" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>`;
                break;
            case 'hairpin-right':
                svgContent = `<path d="M5 20V9a7 7 0 0 1 14 0v11" stroke="#FF9F0A" stroke-width="2.8" stroke-linecap="round"/><polyline points="15 16 19 20 23 16" stroke="#FF9F0A" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>`;
                break;
            case 'sharp-left':
                svgContent = `<path d="M18 19V9a4 4 0 0 0-4-4H5" stroke="#FF9F0A" stroke-width="2.8" stroke-linecap="round"/><polyline points="9 1 4 6 9 11" stroke="#FF9F0A" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>`;
                break;
            case 'sharp-right':
                svgContent = `<path d="M6 19V9a4 4 0 0 1 4-4h9" stroke="#FF9F0A" stroke-width="2.8" stroke-linecap="round"/><polyline points="15 1 20 6 15 11" stroke="#FF9F0A" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>`;
                break;
            case 'turn-left':
            case 'slight-left':
                svgContent = `<path d="M17 19a9 9 0 0 0-9-9H6" stroke="#FFFFFF" stroke-width="2.6" stroke-linecap="round"/><polyline points="10 6 6 10 10 14" stroke="#FFFFFF" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`;
                break;
            case 'turn-right':
            case 'slight-right':
                svgContent = `<path d="M7 19a9 9 0 0 1 9-9h2" stroke="#FFFFFF" stroke-width="2.6" stroke-linecap="round"/><polyline points="14 6 18 10 14 14" stroke="#FFFFFF" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`;
                break;
            case 'off-track':
                svgContent = `<line x1="18" y1="6" x2="6" y2="18" stroke="#FF453A" stroke-width="2.8" stroke-linecap="round"/><line x1="6" y1="6" x2="18" y2="18" stroke="#FF453A" stroke-width="2.8" stroke-linecap="round"/>`;
                break;
            default:
                svgContent = `<line x1="12" y1="19" x2="12" y2="5" stroke="#30D158" stroke-width="2.8" stroke-linecap="round"/><polyline points="5 12 12 5 19 12" stroke="#30D158" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>`;
                break;
        }

        dom.turnIconBox.innerHTML = `
            <svg class="turn-icon-svg" viewBox="0 0 24 24">
                ${svgContent}
            </svg>
        `;
    }

    // =========================================================================
    // 6. GESTION DU MENU FLOTTANT (FAB) & CONTRÔLES UI
    // =========================================================================
    function initUIControls() {
        dom.fabTrigger.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleMenu();
        });

        dom.menuBackdrop.addEventListener('click', () => closeMenu());

        // Action : Bascule Thème Clair / Sombre
        dom.themeToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleTheme();
            closeMenu();
        });

        // Action : Recentrer sur le GPS
        dom.btnRecenter.addEventListener('click', (e) => {
            e.stopPropagation();
            setFollowMode(true);
            state.map.panTo([state.currentPos.lat, state.currentPos.lon], { animate: true, duration: 0.6 });
            closeMenu();
        });

        // Action : Mode Hors-Ligne
        dom.btnOffline.addEventListener('click', (e) => {
            e.stopPropagation();
            closeMenu();
            prepareOfflineDownload();
        });
    }

    function toggleTheme() {
        const isDark = document.body.classList.toggle('dark-theme');
        const newTheme = isDark ? 'dark' : 'light';
        localStorage.setItem('theme', newTheme);
        
        // Mettre à jour la carte sans recharger la page
        const newUrl = isDark ? darkUrl : lightUrl;
        if (state.tileLayer) {
            state.tileLayer.setUrl(newUrl);
        }

        updateThemeButtonUI(newTheme);
    }

    function updateThemeButtonUI(theme) {
        if (!dom.themeLabel || !dom.themeIcon) return;
        
        if (theme === 'dark') {
            dom.themeLabel.textContent = 'Mode Clair';
            // Icône Soleil
            dom.themeIcon.innerHTML = `
                <circle cx="12" cy="12" r="5"></circle>
                <line x1="12" y1="1" x2="12" y2="3"></line>
                <line x1="12" y1="21" x2="12" y2="23"></line>
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
                <line x1="1" y1="12" x2="3" y2="12"></line>
                <line x1="21" y1="12" x2="23" y2="12"></line>
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
            `;
        } else {
            dom.themeLabel.textContent = 'Mode Sombre';
            // Icône Lune
            dom.themeIcon.innerHTML = `
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
            `;
        }
    }

    function toggleMenu() {
        state.isMenuOpen = !state.isMenuOpen;
        dom.fabContainer.classList.toggle('open', state.isMenuOpen);
        dom.fabTrigger.setAttribute('aria-expanded', String(state.isMenuOpen));
        dom.menuBackdrop.classList.toggle('active', state.isMenuOpen);
    }

    function closeMenu() {
        if (!state.isMenuOpen) return;
        state.isMenuOpen = false;
        dom.fabContainer.classList.remove('open');
        dom.fabTrigger.setAttribute('aria-expanded', 'false');
        dom.menuBackdrop.classList.remove('active');
    }

    function setFollowMode(active) {
        state.isFollowing = active;
        if (active) {
            dom.btnRecenter.classList.add('active-tracking');
        } else {
            dom.btnRecenter.classList.remove('active-tracking');
        }
    }

    function showToast(message) {
        dom.toastMsg.textContent = message;
        dom.toastMsg.classList.add('show');
        setTimeout(() => {
            dom.toastMsg.classList.remove('show');
        }, 3000);
    }

    // =========================================================================
    // 7. GESTION DE LA CARTE HORS-LIGNE (CACHE)
    // =========================================================================
    function initOfflineManager() {
        dom.btnCancelModal.addEventListener('click', () => dom.offlineModal.classList.remove('active'));
        dom.btnConfirmDownload.addEventListener('click', startTileDownload);

        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.addEventListener('message', (event) => {
                const data = event.data;
                if (!data) return;

                if (data.type === 'TILE_DOWNLOAD_PROGRESS') {
                    dom.progressBar.style.width = `${data.percentage}%`;
                    dom.progressText.textContent = `${data.percentage}%`;
                    dom.tileCountStat.textContent = `Tuiles : ${data.downloaded} / ${data.total}`;
                } else if (data.type === 'TILE_DOWNLOAD_COMPLETE') {
                    dom.progressBar.style.width = '100%';
                    dom.progressText.textContent = '100%';
                    dom.btnConfirmDownload.disabled = false;
                    dom.btnConfirmDownload.textContent = 'Terminé';
                    showToast('Carte hors-ligne prête');
                }
            });
        }
    }

    function prepareOfflineDownload() {
        let bbox = null;

        if (state.trackPoints.length >= 2) {
            let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
            state.trackPoints.forEach(p => {
                if (p.lat < minLat) minLat = p.lat;
                if (p.lat > maxLat) maxLat = p.lat;
                if (p.lon < minLon) minLon = p.lon;
                if (p.lon > maxLon) maxLon = p.lon;
            });
            bbox = { minLat, maxLat, minLon, maxLon };
        } else {
            const b = state.map.getBounds();
            bbox = {
                minLat: b.getSouth(),
                maxLat: b.getNorth(),
                minLon: b.getWest(),
                maxLon: b.getEast()
            };
        }

        const tiles = GeoMath.getTilesForBoundingBox(bbox, 13, 18);
        state.activeTilesToDownload = tiles;

        const totalTiles = tiles.length;
        const estimatedSizeMb = (totalTiles * 0.022).toFixed(1);

        dom.modalDescription.textContent = `Téléchargement de ${totalTiles} tuiles cartographiques (Zoom 13 à 18, ~${estimatedSizeMb} Mo) pour la zone de navigation.`;
        dom.tileCountStat.textContent = `Tuiles : 0 / ${totalTiles}`;
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

        if (navigator.serviceWorker && navigator.serviceWorker.controller) {
            navigator.serviceWorker.controller.postMessage({
                type: 'START_TILE_DOWNLOAD',
                tileUrls
            });
        } else {
            await downloadTilesDirectly(tileUrls);
        }
    }

    async function downloadTilesDirectly(urls) {
        try {
            const cache = await caches.open('motogps-tiles-v2');
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
            }

            dom.btnConfirmDownload.disabled = false;
            dom.btnConfirmDownload.textContent = 'Terminé';
            showToast('Mise en cache terminée');
        } catch (err) {
            console.error('[Cache] Erreur :', err);
            showToast('Erreur de téléchargement');
            dom.btnConfirmDownload.disabled = false;
            dom.btnConfirmDownload.textContent = 'Réessayer';
        }
    }

    // =========================================================================
    // 8. SERVICE WORKER & DÉMARRAGE (CHEMIN RELATIF GITHUB PAGES)
    // =========================================================================
    function registerServiceWorker() {
        if ('serviceWorker' in navigator) {
            // Chemin absolu pour GitHub Pages : viktorvektor1.github.io/MotoGPS/
            const doRegister = () => {
                navigator.serviceWorker.register('/MotoGPS/sw.js', { scope: '/MotoGPS/' })
                    .then(reg => console.log('[SW] Enregistré sur le scope :', reg.scope))
                    .catch(err => console.warn('[SW] Échec enregistrement :', err));
            };

            if (document.readyState === 'complete') {
                doRegister();
            } else {
                window.addEventListener('load', doRegister);
            }
        }
    }

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
