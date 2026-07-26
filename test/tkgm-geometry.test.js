'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EARTH_RADIUS_M,
  MAX_VERTICES,
  normalizeParcelFeature,
  createLocalProjection,
  classifyStalls,
  buildLayoutFeatureCollection,
} = require('../tkgm-geometry.js');
const { computeBestLayout } = require('../layout.js');

const DEG = Math.PI / 180;

function geographicRectangle(widthM, heightM, lon0 = 32.85, lat0 = 39.92) {
  const dLon = widthM / (EARTH_RADIUS_M * DEG * Math.cos(lat0 * DEG));
  const dLat = heightM / (EARTH_RADIUS_M * DEG);
  return [
    [lon0, lat0], [lon0 + dLon, lat0],
    [lon0 + dLon, lat0 + dLat], [lon0, lat0 + dLat],
    [lon0, lat0],
  ];
}

function featureFromRing(ring, properties = {}) {
  return {
    type: 'Feature',
    properties,
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
}

function everyCoordinate(value, callback) {
  if (!Array.isArray(value)) return;
  if (value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
    callback(value);
    return;
  }
  for (const child of value) everyCoordinate(child, callback);
}

test('normalizes an EPSG:4326 TKGM Polygon and strips unsafe properties', () => {
  const ring = geographicRectangle(100, 80);
  const result = normalizeParcelFeature(featureFromRing(ring, {
    adaNo: 123,
    parselNo: '45',
    ozet: 'Ankara / Test',
    ownerName: 'must not cross the bridge',
    token: 'secret',
  }));
  assert.equal(result.ok, true);
  assert.equal(result.parcel.ring.length, 4, 'closing coordinate must be removed for the engine');
  assert.deepEqual(result.parcel.properties, { adaNo: '123', parselNo: '45', ozet: 'Ankara / Test' });
  assert.equal(Object.hasOwn(result.parcel.properties, 'ownerName'), false);
  assert.equal(Object.hasOwn(result.parcel.properties, 'token'), false);
});

test('rejects MultiPolygon, holes, malformed/range-invalid coordinates and vertex overflow', () => {
  assert.equal(normalizeParcelFeature({ type: 'MultiPolygon', coordinates: [] }).code, 'MULTIPOLYGON_UNSUPPORTED');
  const outer = geographicRectangle(100, 80);
  const hole = geographicRectangle(10, 10, 32.8501, 39.9201);
  assert.equal(normalizeParcelFeature({ type: 'Polygon', coordinates: [outer, hole] }).code, 'POLYGON_HOLES_UNSUPPORTED');
  assert.equal(normalizeParcelFeature({ type: 'Polygon', coordinates: [[[32, 40], [Infinity, 40], [32, 41]]] }).code, 'NON_FINITE_COORDINATE');
  assert.equal(normalizeParcelFeature({ type: 'Polygon', coordinates: [[[181, 40], [32, 40], [32, 41]]] }).code, 'COORDINATE_OUT_OF_RANGE');
  const overflow = Array.from({ length: MAX_VERTICES + 1 }, (_, index) => {
    const angle = index * Math.PI * 2 / (MAX_VERTICES + 1);
    return [32 + Math.cos(angle) * 0.01, 40 + Math.sin(angle) * 0.01];
  });
  overflow.push(overflow[0]);
  assert.equal(normalizeParcelFeature(featureFromRing(overflow)).code, 'TOO_MANY_VERTICES');
});

test('local projection preserves parcel dimensions, area and round trips in Turkey', () => {
  const normalized = normalizeParcelFeature(featureFromRing(geographicRectangle(100, 80)));
  assert.equal(normalized.ok, true);
  const projection = createLocalProjection(normalized.parcel.ring);
  assert.ok(projection);
  assert.ok(Math.abs(projection.areaM2 - 8000) < 0.2, `unexpected area ${projection.areaM2}`);
  assert.ok(Math.abs(Math.hypot(
    projection.polygon[1].x - projection.polygon[0].x,
    projection.polygon[1].y - projection.polygon[0].y
  ) - 100) < 0.01);
  const sample = normalized.parcel.ring[2];
  const roundTrip = projection.fromLocal(projection.toLocal(sample));
  assert.ok(Math.abs(roundTrip[0] - sample[0]) < 1e-12);
  assert.ok(Math.abs(roundTrip[1] - sample[1]) < 1e-12);
});

test('selected TKGM parcel computes locally and converts to bounded GeoJSON overlay', () => {
  const normalized = normalizeParcelFeature(featureFromRing(geographicRectangle(100, 80), { adaNo: '10', parselNo: '20' }));
  const projection = createLocalProjection(normalized.parcel.ring);
  const options = {
    stallWidthM: 2.5,
    stallDepthM: 5,
    aisleWidthM: 6,
    angleStepDeg: 30,
    backToBack: true,
    fillEmpty: false,
    gates: [],
  };
  const layout = computeBestLayout(projection.polygon, 1, options);
  assert.ok(layout && layout.count > 0);
  const classification = classifyStalls(layout.stalls, layout.angleDeg, 1, options);
  assert.equal(classification.types.length, layout.stalls.length);
  assert.equal(classification.metadata.totalParking + classification.metadata.landscape, layout.count);
  const collection = buildLayoutFeatureCollection(normalized.parcel, projection, layout, classification);
  assert.equal(collection.type, 'FeatureCollection');
  assert.equal(collection.features[0].properties.kind, 'parcel');
  assert.ok(collection.features.some((item) => item.properties.kind === 'aisle'));
  assert.ok(collection.features.some((item) => item.properties.kind === 'standard'));
  for (const item of collection.features) {
    everyCoordinate(item.geometry.coordinates, ([lng, lat]) => {
      assert.ok(Number.isFinite(lng) && lng >= -180 && lng <= 180);
      assert.ok(Number.isFinite(lat) && lat >= -90 && lat <= 90);
    });
  }
});

test('overlay conversion rejects non-finite engine output', () => {
  const normalized = normalizeParcelFeature(featureFromRing(geographicRectangle(40, 40)));
  const projection = createLocalProjection(normalized.parcel.ring);
  const invalidLayout = {
    stalls: [[{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: NaN, y: 5 }, { x: 0, y: 5 }]],
    aisles: [],
  };
  assert.equal(buildLayoutFeatureCollection(normalized.parcel, projection, invalidLayout, null), null);
});
