// tkgm-geometry.js — TKGM GeoJSON doğrulama ve yerel metrik dönüşüm yardımcıları.
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.defineProperty(root, "OPLTKGMGeometry", { value: api, configurable: false, writable: false });
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const EARTH_RADIUS_M = 6378137;
  const DEG = Math.PI / 180;
  const MAX_VERTICES = 512;
  const PROPERTY_KEYS = Object.freeze(["adaNo", "parselNo", "ozet", "zeminId", "parselId"]);

  function failure(code) {
    return { ok: false, code };
  }

  function sameCoordinate(a, b) {
    return Math.abs(a[0] - b[0]) <= 1e-12 && Math.abs(a[1] - b[1]) <= 1e-12;
  }

  function safeProperty(value) {
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    const text = String(value).trim();
    return text ? text.slice(0, 120) : undefined;
  }

  function sanitizeProperties(properties) {
    const clean = {};
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) return clean;
    for (const key of PROPERTY_KEYS) {
      const value = safeProperty(properties[key]);
      if (value !== undefined) clean[key] = value;
    }
    return clean;
  }

  function normalizeParcelFeature(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return failure("INVALID_FEATURE");
    const isFeature = input.type === "Feature";
    const geometry = isFeature ? input.geometry : input;
    if (!geometry || typeof geometry !== "object" || Array.isArray(geometry)) return failure("INVALID_GEOMETRY");
    if (geometry.type === "MultiPolygon") return failure("MULTIPOLYGON_UNSUPPORTED");
    if (geometry.type !== "Polygon") return failure("POLYGON_REQUIRED");
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length < 1) return failure("INVALID_COORDINATES");
    if (geometry.coordinates.length !== 1) return failure("POLYGON_HOLES_UNSUPPORTED");

    const sourceRing = geometry.coordinates[0];
    if (!Array.isArray(sourceRing) || sourceRing.length < 3) return failure("TOO_FEW_VERTICES");
    const ring = [];
    for (const coordinate of sourceRing) {
      if (!Array.isArray(coordinate) || coordinate.length < 2) return failure("INVALID_COORDINATES");
      const lng = Number(coordinate[0]);
      const lat = Number(coordinate[1]);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return failure("NON_FINITE_COORDINATE");
      if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return failure("COORDINATE_OUT_OF_RANGE");
      const point = [lng, lat];
      if (!ring.length || !sameCoordinate(point, ring[ring.length - 1])) ring.push(point);
    }
    if (ring.length > 1 && sameCoordinate(ring[0], ring[ring.length - 1])) ring.pop();
    if (ring.length < 3) return failure("TOO_FEW_VERTICES");
    if (ring.length > MAX_VERTICES) return failure("TOO_MANY_VERTICES");

    return {
      ok: true,
      parcel: {
        ring,
        properties: sanitizeProperties(isFeature ? input.properties : null),
      },
    };
  }

  function createLocalProjection(ring) {
    if (!Array.isArray(ring) || ring.length < 3) return null;
    let lon0 = 0;
    let lat0 = 0;
    for (const coordinate of ring) {
      if (!Array.isArray(coordinate) || coordinate.length < 2 ||
          !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) return null;
      lon0 += coordinate[0];
      lat0 += coordinate[1];
    }
    lon0 /= ring.length;
    lat0 /= ring.length;
    const cosLat0 = Math.cos(lat0 * DEG);
    if (!Number.isFinite(cosLat0) || Math.abs(cosLat0) < 1e-6) return null;

    const toLocal = (coordinate) => ({
      x: EARTH_RADIUS_M * (coordinate[0] - lon0) * DEG * cosLat0,
      y: EARTH_RADIUS_M * (coordinate[1] - lat0) * DEG,
    });
    const fromLocal = (point) => [
      lon0 + point.x / (EARTH_RADIUS_M * DEG * cosLat0),
      lat0 + point.y / (EARTH_RADIUS_M * DEG),
    ];
    const polygon = ring.map(toLocal);
    const areaM2 = polygonArea(polygon);
    if (!Number.isFinite(areaM2) || areaM2 <= 0) return null;
    return { lon0, lat0, polygon, areaM2, toLocal, fromLocal };
  }

  function polygonArea(points) {
    if (!Array.isArray(points) || points.length < 3) return 0;
    let twiceArea = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if (!a || !b || !Number.isFinite(a.x) || !Number.isFinite(a.y) ||
          !Number.isFinite(b.x) || !Number.isFinite(b.y)) return 0;
      twiceArea += a.x * b.y - b.x * a.y;
    }
    return Math.abs(twiceArea) / 2;
  }

  function centroid(quad) {
    let x = 0;
    let y = 0;
    for (const point of quad) {
      x += point.x;
      y += point.y;
    }
    return { x: x / quad.length, y: y / quad.length };
  }

  // Google adaptöründeki işaretleme semantiğini korur: erişilebilir/EV toplamın
  // içindedir; uzun sıra uçlarındaki peyzaj adaları kapasiteden düşülür.
  function classifyStalls(stalls, angleDeg, mpp, options) {
    const n = Array.isArray(stalls) ? stalls.length : 0;
    const types = Array.from({ length: n }, () => "standard");
    if (!n) return { types, metadata: { totalParking: 0, accessible: 0, ev: 0, landscape: 0 } };
    const safeMpp = Number.isFinite(mpp) && mpp > 0 ? mpp : 1;
    const stallDepthM = options && Number.isFinite(options.stallDepthM) ? options.stallDepthM : 5;
    const angle = Number.isFinite(angleDeg) ? angleDeg : 0;
    const rotation = -(angle * DEG);
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const layoutRad = angle * DEG;
    const info = stalls.map((stall, index) => {
      const c = centroid(stall);
      const edge = Math.atan2(stall[1].y - stall[0].y, stall[1].x - stall[0].x);
      let delta = Math.abs((edge - layoutRad) % (Math.PI / 2));
      if (delta > Math.PI / 4) delta = Math.PI / 2 - delta;
      return {
        index,
        c,
        rx: c.x * cos - c.y * sin,
        ry: c.x * sin + c.y * cos,
        aligned: delta < 0.2,
      };
    });

    const rowTolerance = stallDepthM / safeMpp * 0.6;
    const sorted = info.filter((item) => item.aligned).sort((a, b) => a.ry - b.ry || a.rx - b.rx);
    const rows = [];
    let current = [];
    for (const item of sorted) {
      if (current.length && item.ry - current[current.length - 1].ry > rowTolerance) {
        rows.push(current);
        current = [];
      }
      current.push(item);
    }
    if (current.length) rows.push(current);
    for (const row of rows) {
      row.sort((a, b) => a.rx - b.rx);
      if (row.length >= 10) {
        types[row[0].index] = "landscape";
        types[row[row.length - 1].index] = "landscape";
      }
      if (row.length >= 24) types[row[Math.floor(row.length / 2)].index] = "landscape";
    }

    const front = info.reduce((best, item) => item.ry < best.ry ? item : best, info[0]);
    const side = info.reduce((best, item) => item.rx > best.rx ? item : best, info[0]);
    function tagNearest(anchor, count, type) {
      const candidates = info
        .filter((item) => types[item.index] === "standard")
        .sort((a, b) => Math.hypot(a.c.x - anchor.x, a.c.y - anchor.y) -
          Math.hypot(b.c.x - anchor.x, b.c.y - anchor.y));
      for (const item of candidates.slice(0, count)) types[item.index] = type;
    }
    tagNearest(front.c, Math.min(8, Math.max(4, Math.ceil(n * 0.04))), "accessible");
    tagNearest(side.c, Math.min(12, Math.max(4, Math.ceil(n * 0.06))), "ev");

    const count = (type) => types.filter((value) => value === type).length;
    const landscape = count("landscape");
    return {
      types,
      metadata: {
        totalParking: n - landscape,
        accessible: count("accessible"),
        ev: count("ev"),
        landscape,
      },
    };
  }

  function closeGeographicRing(points, fromLocal) {
    if (!Array.isArray(points) || points.length < 3) return null;
    const ring = [];
    for (const point of points) {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
      const coordinate = fromLocal(point);
      if (!Array.isArray(coordinate) || !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) return null;
      ring.push(coordinate);
    }
    ring.push(ring[0].slice());
    return ring;
  }

  function feature(kind, geometry) {
    return { type: "Feature", properties: { kind }, geometry };
  }

  function buildLayoutFeatureCollection(parcel, projection, layout, classification) {
    if (!parcel || !projection || !layout || !Array.isArray(layout.stalls) || !Array.isArray(layout.aisles)) return null;
    const parcelRing = parcel.ring.map((coordinate) => coordinate.slice());
    parcelRing.push(parcelRing[0].slice());
    const features = [feature("parcel", { type: "Polygon", coordinates: [parcelRing] })];

    function addQuads(kind, quads) {
      if (!quads.length) return true;
      const polygons = [];
      for (const quad of quads) {
        const ring = closeGeographicRing(quad, projection.fromLocal);
        if (!ring) return false;
        polygons.push([ring]);
      }
      features.push(feature(kind, { type: "MultiPolygon", coordinates: polygons }));
      return true;
    }

    if (!addQuads("aisle", layout.aisles)) return null;
    const types = classification && Array.isArray(classification.types) && classification.types.length === layout.stalls.length
      ? classification.types
      : layout.stalls.map(() => "standard");
    for (const kind of ["standard", "accessible", "ev"]) {
      const quads = layout.stalls.filter((_, index) => types[index] === kind);
      if (!addQuads(kind, quads)) return null;
    }
    const landscapeCoordinates = layout.stalls
      .filter((_, index) => types[index] === "landscape")
      .map((quad) => projection.fromLocal(centroid(quad)));
    if (landscapeCoordinates.length) {
      features.push(feature("landscape", { type: "MultiPoint", coordinates: landscapeCoordinates }));
    }
    return { type: "FeatureCollection", features };
  }

  return Object.freeze({
    EARTH_RADIUS_M,
    MAX_VERTICES,
    normalizeParcelFeature,
    createLocalProjection,
    polygonArea,
    classifyStalls,
    buildLayoutFeatureCollection,
  });
});
