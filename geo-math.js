/**
 * =====================================================================
 * geo-math.js - Moteur Mathématique et Trigonométrie Sphérique pour MotoGPS
 * =====================================================================
 * Fournit les calculs géodésiques, le Map-Matching haute performance,
 * l'anticipation des virages et l'ajustement dynamique du zoom.
 * =====================================================================
 */

const GeoMath = (function () {
    'use strict';

    // Rayon moyen de la Terre en mètres (WGS84)
    const EARTH_RADIUS_METERS = 6371000;

    /**
     * Convertit des degrés en radians.
     * @param {number} deg 
     * @returns {number} rad
     */
    function toRad(deg) {
        return (deg * Math.PI) / 180;
    }

    /**
     * Convertit des radians en degrés.
     * @param {number} rad 
     * @returns {number} deg
     */
    function toDeg(rad) {
        return (rad * 180) / Math.PI;
    }

    /**
     * Normalise un angle en degrés dans l'intervalle [0, 360[.
     * @param {number} deg 
     * @returns {number}
     */
    function normalizeAngle(deg) {
        let angle = deg % 360;
        if (angle < 0) angle += 360;
        return angle;
    }

    /**
     * Calcule la distance grand-cercle (Haversine) entre deux coordonnées en mètres.
     * @param {number} lat1 Latitude point 1
     * @param {number} lon1 Longitude point 1
     * @param {number} lat2 Latitude point 2
     * @param {number} lon2 Longitude point 2
     * @returns {number} Distance en mètres
     */
    function haversineDistance(lat1, lon1, lat2, lon2) {
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const phi1 = toRad(lat1);
        const phi2 = toRad(lat2);

        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(phi1) * Math.cos(phi2) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);

        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return EARTH_RADIUS_METERS * c;
    }

    /**
     * Calcule le cap initial (Bearing / Azimut) de départ du point 1 vers le point 2 en degrés [0, 360[.
     * @param {number} lat1 
     * @param {number} lon1 
     * @param {number} lat2 
     * @param {number} lon2 
     * @returns {number} Cap en degrés (0° = Nord, 90° = Est, 180° = Sud, 270° = Ouest)
     */
    function calculateBearing(lat1, lon1, lat2, lon2) {
        const phi1 = toRad(lat1);
        const phi2 = toRad(lat2);
        const lambda1 = toRad(lon1);
        const lambda2 = toRad(lon2);
        const dLambda = lambda2 - lambda1;

        const y = Math.sin(dLambda) * Math.cos(phi2);
        const x = Math.cos(phi1) * Math.sin(phi2) -
                  Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);

        const theta = Math.atan2(y, x);
        return normalizeAngle(toDeg(theta));
    }

    /**
     * Calcule la différence d'angle la plus courte entre deux caps, avec gestion
     * parfaite du franchissement du méridien Nord (360° -> 0°).
     * @param {number} bearing1 Cap d'origine (ex: 350°)
     * @param {number} bearing2 Cap de destination (ex: 10°)
     * @returns {number} Différence d'angle en degrés dans l'intervalle [-180, 180].
     *                   Positif = Virage à droite, Négatif = Virage à gauche.
     */
    function angleDifference(bearing1, bearing2) {
        let diff = (bearing2 - bearing1 + 180) % 360 - 180;
        if (diff < -180) diff += 360;
        return diff;
    }

    /**
     * Projette un point P(lat, lon) sur un segment géodésique [A, B].
     * Utilise une projection équirectangulaire locale adaptée aux courtes distances (< 10 km).
     * 
     * @param {{lat: number, lon: number}} p Position du motard
     * @param {{lat: number, lon: number}} a Début du segment
     * @param {{lat: number, lon: number}} b Fin du segment
     * @returns {{
     *   point: {lat: number, lon: number},
     *   fraction: number,
     *   distanceMeters: number
     * }}
     */
    function projectPointOnSegment(p, a, b) {
        const midLat = toRad((a.lat + b.lat) / 2);
        const cosLat = Math.cos(midLat);

        // Conversion en coordonnées cartésiennes locales (en mètres)
        const ax = toRad(a.lon) * EARTH_RADIUS_METERS * cosLat;
        const ay = toRad(a.lat) * EARTH_RADIUS_METERS;

        const bx = toRad(b.lon) * EARTH_RADIUS_METERS * cosLat;
        const by = toRad(b.lat) * EARTH_RADIUS_METERS;

        const px = toRad(p.lon) * EARTH_RADIUS_METERS * cosLat;
        const py = toRad(p.lat) * EARTH_RADIUS_METERS;

        const abx = bx - ax;
        const aby = by - ay;
        const segmentLengthSq = abx * abx + aby * aby;

        if (segmentLengthSq === 0) {
            const d = haversineDistance(p.lat, p.lon, a.lat, a.lon);
            return { point: { lat: a.lat, lon: a.lon }, fraction: 0, distanceMeters: d };
        }

        // Projection scalaire normalisée t dans [0, 1]
        const apx = px - ax;
        const apy = py - ay;
        let t = (apx * abx + apy * aby) / segmentLengthSq;
        t = Math.max(0, Math.min(1, t));

        // Coordonnées géographiques projetées
        const projLat = a.lat + t * (b.lat - a.lat);
        const projLon = a.lon + t * (b.lon - a.lon);
        const distance = haversineDistance(p.lat, p.lon, projLat, projLon);

        return {
            point: { lat: projLat, lon: projLon },
            fraction: t,
            distanceMeters: distance
        };
    }

    /**
     * Map Matching : Recherche le segment le plus proche de la moto sur la trace GPX.
     * Pour une grande trace, optimise la recherche autour du dernier index connu.
     * 
     * @param {{lat: number, lon: number}} currentPos Position GPS actuelle
     * @param {Array<{lat: number, lon: number}>} trackPoints Liste ordonnée des points de la trace
     * @param {number} [lastKnownIndex=0] Dernier index de segment identifié (optimisation)
     * @returns {{
     *   segmentIndex: number,
     *   projectedPoint: {lat: number, lon: number},
     *   distanceToTrack: number,
     *   fraction: number
     * }}
     */
    function findClosestSegment(currentPos, trackPoints, lastKnownIndex = 0) {
        if (!trackPoints || trackPoints.length < 2) {
            return {
                segmentIndex: 0,
                projectedPoint: currentPos,
                distanceToTrack: 0,
                fraction: 0
            };
        }

        let bestDist = Infinity;
        let bestSegmentIndex = 0;
        let bestProjectedPoint = null;
        let bestFraction = 0;

        // Définir la fenêtre de recherche : locale si lastKnownIndex est valide, sinon globale
        let startIndex = 0;
        let endIndex = trackPoints.length - 1;

        if (lastKnownIndex > 0 && lastKnownIndex < trackPoints.length - 1) {
            // Recherche dans une fenêtre de +/- 40 segments autour de la dernière position connue
            startIndex = Math.max(0, lastKnownIndex - 10);
            endIndex = Math.min(trackPoints.length - 1, lastKnownIndex + 40);
        }

        for (let i = startIndex; i < endIndex; i++) {
            const a = trackPoints[i];
            const b = trackPoints[i + 1];
            const proj = projectPointOnSegment(currentPos, a, b);

            if (proj.distanceMeters < bestDist) {
                bestDist = proj.distanceMeters;
                bestSegmentIndex = i;
                bestProjectedPoint = proj.point;
                bestFraction = proj.fraction;
            }
        }

        // Si la distance trouvée est trop grande (> 250m) et qu'on avait restreint la recherche,
        // faire un scan global pour rattraper la trace (ex: pause ou reprise hors itinéraire)
        if (bestDist > 250 && startIndex !== 0) {
            return findClosestSegment(currentPos, trackPoints, 0);
        }

        return {
            segmentIndex: bestSegmentIndex,
            projectedPoint: bestProjectedPoint,
            distanceToTrack: bestDist,
            fraction: bestFraction
        };
    }

    /**
     * Avance le long de la trace GPX d'une distance donnée en mètres pour trouver le "Point Cible".
     * 
     * @param {Array<{lat: number, lon: number}>} trackPoints 
     * @param {number} segmentIndex Index du segment actuel
     * @param {number} fraction Position relative sur le segment [0, 1]
     * @param {number} distanceMeters Distance d'anticipation à parcourir (ex: 80 mètres)
     * @returns {{
     *   targetPoint: {lat: number, lon: number},
     *   targetIndex: number,
     *   actualDistanceMeters: number
     * }}
     */
    function getTargetPointAhead(trackPoints, segmentIndex, fraction, distanceMeters) {
        if (!trackPoints || trackPoints.length === 0) {
            return { targetPoint: null, targetIndex: 0, actualDistanceMeters: 0 };
        }

        let remainingDist = distanceMeters;
        let currentIndex = segmentIndex;

        // Distance restante sur le segment en cours
        const a = trackPoints[currentIndex];
        const b = trackPoints[currentIndex + 1] || a;
        const currentSegmentTotalDist = haversineDistance(a.lat, a.lon, b.lat, b.lon);
        const distToEndOfSegment = (1 - fraction) * currentSegmentTotalDist;

        if (remainingDist <= distToEndOfSegment) {
            const newFraction = fraction + (remainingDist / (currentSegmentTotalDist || 1));
            return {
                targetPoint: {
                    lat: a.lat + newFraction * (b.lat - a.lat),
                    lon: a.lon + newFraction * (b.lon - a.lon)
                },
                targetIndex: currentIndex,
                actualDistanceMeters: distanceMeters
            };
        }

        remainingDist -= distToEndOfSegment;
        currentIndex++;

        // Parcourir les segments suivants
        while (currentIndex < trackPoints.length - 1) {
            const p1 = trackPoints[currentIndex];
            const p2 = trackPoints[currentIndex + 1];
            const segDist = haversineDistance(p1.lat, p1.lon, p2.lat, p2.lon);

            if (remainingDist <= segDist) {
                const t = remainingDist / (segDist || 1);
                return {
                    targetPoint: {
                        lat: p1.lat + t * (p2.lat - p1.lat),
                        lon: p1.lon + t * (p2.lon - p1.lon)
                    },
                    targetIndex: currentIndex,
                    actualDistanceMeters: distanceMeters
                };
            }

            remainingDist -= segDist;
            currentIndex++;
        }

        // Fin de la trace atteinte
        const lastPt = trackPoints[trackPoints.length - 1];
        return {
            targetPoint: { lat: lastPt.lat, lon: lastPt.lon },
            targetIndex: trackPoints.length - 1,
            actualDistanceMeters: distanceMeters - remainingDist
        };
    }

    /**
     * Analyse la courbure (différence de cap) sur les N prochains points après le point cible.
     * Détecte les virages légers, serrés ou les épingles à cheveux.
     * 
     * @param {Array<{lat: number, lon: number}>} trackPoints 
     * @param {number} startIndex Index à partir duquel analyser la courbe
     * @param {number} [sampleCount=3] Nombre de segments consécutifs à évaluer
     * @returns {{
     *   cumulativeAngleDeg: number,
     *   maxSingleTurnDeg: number,
     *   turnDirection: 'straight' | 'right' | 'left',
     *   severity: 'straight' | 'slight' | 'moderate' | 'sharp' | 'hairpin'
     * }}
     */
    function calculateCurvatureAhead(trackPoints, startIndex, sampleCount = 3) {
        if (!trackPoints || startIndex >= trackPoints.length - 1) {
            return {
                cumulativeAngleDeg: 0,
                maxSingleTurnDeg: 0,
                turnDirection: 'straight',
                severity: 'straight'
            };
        }

        let totalAngleChange = 0;
        let maxSingleTurn = 0;
        let dominantSign = 0;

        const maxIndex = Math.min(trackPoints.length - 1, startIndex + sampleCount + 1);

        for (let i = startIndex; i < maxIndex - 1; i++) {
            const p1 = trackPoints[i];
            const p2 = trackPoints[i + 1];
            const p3 = trackPoints[i + 2];

            if (!p3) break;

            const bearing1 = calculateBearing(p1.lat, p1.lon, p2.lat, p2.lon);
            const bearing2 = calculateBearing(p2.lat, p2.lon, p3.lat, p3.lon);

            // Différence signée (-180° à +180°) avec gestion 360°/0°
            const diff = angleDifference(bearing1, bearing2);

            totalAngleChange += diff;
            if (Math.abs(diff) > Math.abs(maxSingleTurn)) {
                maxSingleTurn = diff;
            }
            dominantSign += diff;
        }

        const absTotal = Math.abs(totalAngleChange);
        const absMax = Math.abs(maxSingleTurn);

        // Détermination de la direction
        let turnDirection = 'straight';
        if (dominantSign > 8) turnDirection = 'right';
        else if (dominantSign < -8) turnDirection = 'left';

        // Évaluation de la sévérité du virage
        let severity = 'straight';
        if (absTotal >= 85 || absMax >= 75) {
            severity = 'hairpin'; // Épingle à cheveux
        } else if (absTotal >= 45 || absMax >= 40) {
            severity = 'sharp'; // Virage serré
        } else if (absTotal >= 22 || absMax >= 18) {
            severity = 'moderate'; // Virage moyen
        } else if (absTotal >= 10 || absMax >= 8) {
            severity = 'slight'; // Courbe légère
        }

        return {
            cumulativeAngleDeg: Math.round(totalAngleChange),
            maxSingleTurnDeg: Math.round(maxSingleTurn),
            turnDirection: turnDirection,
            severity: severity
        };
    }

    /**
     * Détermine le niveau de zoom optimal de la carte en fonction de la vitesse
     * et de la courbure à venir (Anticipation de virage).
     * 
     * Règle motarde :
     * - Haute vitesse en ligne droite (> 90 km/h) -> Dézoom (14-15) pour anticiper loin.
     * - Vitesse modérée ou courbes moyennes -> Zoom intermédiaire (16-17).
     * - Approche d'épingle / virage serré ou basse vitesse -> Zoom resserré (18) pour visualiser la trajectoire.
     * 
     * @param {number} speedKmh Vitesse instantanée en km/h
     * @param {{severity: string, cumulativeAngleDeg: number}} curvatureInfo Analyse de la courbure
     * @returns {number} Niveau de zoom cible (14 à 18)
     */
    function calculateDynamicZoom(speedKmh, curvatureInfo) {
        const severity = curvatureInfo ? curvatureInfo.severity : 'straight';
        const speed = Math.max(0, speedKmh || 0);

        // 1. Priorité aux virages dangereux / épingles
        if (severity === 'hairpin') {
            return 18; // Zoom maximal pour voir la géométrie exacte de l'épingle
        }
        if (severity === 'sharp') {
            return speed > 70 ? 17 : 18;
        }
        if (severity === 'moderate') {
            return speed > 80 ? 16 : 17;
        }

        // 2. Ligne droite ou courbe très légère : adaptation selon la vitesse
        if (speed >= 110) {
            return 14; // Autoroute / voie rapide dégagée
        } else if (speed >= 75) {
            return 15; // Nationale rapide
        } else if (speed >= 40) {
            return 16; // Route secondaire / ville fluide
        } else {
            return 17; // Manœuvre / arrêt / basse vitesse
        }
    }

    /**
     * Conversion longitude -> coordonnée de tuile X pour OSM/Mercator.
     * @param {number} lon 
     * @param {number} zoom 
     * @returns {number}
     */
    function lon2tile(lon, zoom) {
        return Math.floor(((lon + 180) / 360) * Math.pow(2, zoom));
    }

    /**
     * Conversion latitude -> coordonnée de tuile Y pour OSM/Mercator.
     * @param {number} lat 
     * @param {number} zoom 
     * @returns {number}
     */
    function lat2tile(lat, zoom) {
        const rad = toRad(lat);
        return Math.floor(
            ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, zoom)
        );
    }

    /**
     * Calcule l'ensemble des coordonnées de tuiles (Z/X/Y) nécessaires pour couvrir
     * une boîte englobante (Bounding Box) sur une plage de niveaux de zoom donnée.
     * 
     * @param {{minLat: number, minLon: number, maxLat: number, maxLon: number}} bbox 
     * @param {number} [minZoom=13] Zoom minimal
     * @param {number} [maxZoom=18] Zoom maximal
     * @returns {Array<{z: number, x: number, y: number, url: string}>}
     */
    function getTilesForBoundingBox(bbox, minZoom = 13, maxZoom = 18) {
        const tiles = [];
        const seen = new Set();

        // Marge de sécurité (buffer de ~0.015° ~1.5 km autour de la trace)
        const margin = 0.015;
        const minLat = Math.max(-85.0511, bbox.minLat - margin);
        const maxLat = Math.min(85.0511, bbox.maxLat + margin);
        const minLon = Math.max(-180, bbox.minLon - margin);
        const maxLon = Math.min(180, bbox.maxLon + margin);

        for (let z = minZoom; z <= maxZoom; z++) {
            const minX = lon2tile(minLon, z);
            const maxX = lon2tile(maxLon, z);
            // En coordonnées Web Mercator, Y=0 est au Pôle Nord, donc maxLat correspond à minY
            const minY = lat2tile(maxLat, z);
            const maxY = lat2tile(minLat, z);

            for (let x = minX; x <= maxX; x++) {
                for (let y = minY; y <= maxY; y++) {
                    const key = `${z}/${x}/${y}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        // Serveurs subdomains 'a', 'b', 'c', 'd' pour CartoDB Dark Matter
                        const sub = ['a', 'b', 'c', 'd'][(x + y) % 4];
                        tiles.push({
                            z: z,
                            x: x,
                            y: y,
                            url: `https://${sub}.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`
                        });
                    }
                }
            }
        }

        return tiles;
    }

    // Exposer publiquement l'API du module
    return {
        EARTH_RADIUS_METERS,
        toRad,
        toDeg,
        normalizeAngle,
        haversineDistance,
        calculateBearing,
        angleDifference,
        projectPointOnSegment,
        findClosestSegment,
        getTargetPointAhead,
        calculateCurvatureAhead,
        calculateDynamicZoom,
        lon2tile,
        lat2tile,
        getTilesForBoundingBox
    };
})();

// Exportation universelle (Navigateur / Web Worker / CommonJS)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = GeoMath;
}
