'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeBestLayout, fillBaysForAisles } = require('../layout.js');

const OPTIONS = Object.freeze({
  stallWidthM: 2.5,
  stallDepthM: 5,
  aisleWidthM: 6,
  angleStepDeg: 30,
  backToBack: true,
});

const rectangle = (width, height) => [
  { x: 0, y: 0 }, { x: width, y: 0 },
  { x: width, y: height }, { x: 0, y: height },
];

function finiteLayout(layout) {
  assert.ok(layout, 'layout should exist');
  assert.ok(Number.isInteger(layout.count) && layout.count >= 0);
  if (Object.hasOwn(layout, 'angleDeg')) assert.ok(Number.isFinite(layout.angleDeg));
  assert.ok(Number.isFinite(layout.areaM2) && layout.areaM2 > 0);
  for (const group of [layout.stalls, layout.aisles]) {
    assert.ok(Array.isArray(group));
    for (const quad of group) {
      assert.equal(quad.length, 4);
      for (const point of quad) {
        assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), 'quad coordinates must be finite');
      }
    }
  }
  assert.equal(layout.count, layout.stalls.length);
  assert.ok(Array.isArray(layout.metadata.warnings));
  assert.ok(Array.isArray(layout.metadata.regionAnglesDeg));
}

// Boundary-inclusive geometry helpers. Segment containment checks every interval
// created by exact polygon-edge intersections; checking only quad corners would
// miss an edge that crosses a concavity.
function cross(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function epsilon(points) {
  return Math.max(1, ...points.flatMap((p) => [Math.abs(p.x), Math.abs(p.y)])) * 1e-9;
}

function pointOnSegment(p, a, b, eps = epsilon([p, a, b])) {
  return Math.abs(cross(a, b, p)) <= eps * Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)) &&
    p.x >= Math.min(a.x, b.x) - eps && p.x <= Math.max(a.x, b.x) + eps &&
    p.y >= Math.min(a.y, b.y) - eps && p.y <= Math.max(a.y, b.y) + eps;
}

function pointInPolygon(point, polygon) {
  const eps = epsilon(polygon.concat(point));
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    if (pointOnSegment(point, a, b, eps)) return true;
    if (b.y > point.y !== a.y > point.y &&
        point.x < ((a.x - b.x) * (point.y - b.y)) / (a.y - b.y) + b.x) inside = !inside;
  }
  return inside;
}

function segmentInsidePolygon(a, b, polygon) {
  if (!pointInPolygon(a, polygon) || !pointInPolygon(b, polygon)) return false;
  const dx = b.x - a.x, dy = b.y - a.y;
  const eps = epsilon(polygon.concat([a, b]));
  const ts = [0, 1];
  for (let i = 0; i < polygon.length; i++) {
    const c = polygon[i], d = polygon[(i + 1) % polygon.length];
    const ex = d.x - c.x, ey = d.y - c.y;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) > eps) {
      const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / den;
      const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / den;
      if (t >= -eps && t <= 1 + eps && u >= -eps && u <= 1 + eps) ts.push(Math.max(0, Math.min(1, t)));
    } else {
      for (const p of [c, d]) {
        if (!pointOnSegment(p, a, b, eps)) continue;
        const t = Math.abs(dx) >= Math.abs(dy) ? (p.x - a.x) / (dx || 1) : (p.y - a.y) / (dy || 1);
        if (t >= -eps && t <= 1 + eps) ts.push(Math.max(0, Math.min(1, t)));
      }
    }
  }
  ts.sort((x, y) => x - y);
  for (let i = 1; i < ts.length; i++) {
    if (ts[i] - ts[i - 1] <= eps) continue;
    const t = (ts[i] + ts[i - 1]) / 2;
    if (!pointInPolygon({ x: a.x + dx * t, y: a.y + dy * t }, polygon)) return false;
  }
  return true;
}

function quadInsidePolygon(quad, polygon) {
  return quad.every((point, i) => segmentInsidePolygon(point, quad[(i + 1) % quad.length], polygon));
}

function assertAllQuadsInside(layout, polygon) {
  for (const [kind, quads] of [['stall', layout.stalls], ['aisle', layout.aisles]]) {
    quads.forEach((quad, index) => assert.ok(quadInsidePolygon(quad, polygon), `${kind} ${index} escapes polygon`));
  }
}

function rotatedRoad(cx, cy, length, width, angle) {
  const u = { x: Math.cos(angle), y: Math.sin(angle) };
  const n = { x: -u.y, y: u.x };
  return [
    { x: cx - u.x * length / 2 + n.x * width / 2, y: cy - u.y * length / 2 + n.y * width / 2 },
    { x: cx + u.x * length / 2 + n.x * width / 2, y: cy + u.y * length / 2 + n.y * width / 2 },
    { x: cx + u.x * length / 2 - n.x * width / 2, y: cy + u.y * length / 2 - n.y * width / 2 },
    { x: cx - u.x * length / 2 - n.x * width / 2, y: cy - u.y * length / 2 - n.y * width / 2 },
  ];
}

test('baseline layout is finite and connectivity is verified', () => {
  const polygon = rectangle(100, 80);
  const layout = computeBestLayout(polygon, 1, OPTIONS);
  finiteLayout(layout);
  assert.ok(layout.count > 0);
  assert.equal(layout.metadata.connectivity.connected, true);
  assert.equal(layout.metadata.connectivity.aisleComponentsBefore, 1);
  assert.equal(layout.metadata.connectivity.retainedStalls, layout.count);
  assertAllQuadsInside(layout, polygon);
});

const concaveCases = {
  U: [
    { x: 0, y: 0 }, { x: 90, y: 0 }, { x: 90, y: 80 }, { x: 65, y: 80 },
    { x: 65, y: 30 }, { x: 25, y: 30 }, { x: 25, y: 80 }, { x: 0, y: 80 },
  ],
  C: [
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 20 }, { x: 30, y: 20 },
    { x: 30, y: 70 }, { x: 100, y: 70 }, { x: 100, y: 90 }, { x: 0, y: 90 },
  ],
};

for (const [name, polygon] of Object.entries(concaveCases)) {
  test(`${name}-shaped concave parcel keeps every full quad inside`, () => {
    const layout = computeBestLayout(polygon, 1, OPTIONS);
    finiteLayout(layout);
    assert.ok(layout.count > 0);
    assert.equal(layout.metadata.connectivity.connected, true);
    assertAllQuadsInside(layout, polygon);
  });
}

test('invalid polygons, scale and options are rejected through the public API', () => {
  const bowTie = [{ x: 0, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }, { x: 40, y: 0 }];
  const road = [{ x: 5, y: 15 }, { x: 35, y: 15 }, { x: 35, y: 21 }, { x: 5, y: 21 }];
  assert.equal(computeBestLayout(bowTie, 1, OPTIONS), null);
  assert.equal(computeBestLayout([{ x: 0, y: 0 }, { x: 1, y: 1 }], 1, OPTIONS), null);
  assert.equal(computeBestLayout(rectangle(40, 40), 0, OPTIONS), null);
  assert.equal(computeBestLayout(rectangle(40, 40), 1, { ...OPTIONS, stallWidthM: -1 }), null);
  assert.equal(computeBestLayout(rectangle(40, 40), 1, { ...OPTIONS, aisleWidthM: Infinity }), null);
  assert.equal(computeBestLayout(rectangle(40, 40), 1, { ...OPTIONS, angleStepDeg: 0 }), null);
  assert.equal(fillBaysForAisles(rectangle(40, 40), 1, { ...OPTIONS, stallDepthM: NaN }, [road]), null);
  assert.equal(fillBaysForAisles(rectangle(40, 40), 1, OPTIONS, []), null);
});

test('entry gate chooses its component when edited roads are disconnected', () => {
  const polygon = rectangle(160, 100);
  const roads = [
    [{ x: 10, y: 20 }, { x: 75, y: 20 }, { x: 75, y: 26 }, { x: 10, y: 26 }],
    [{ x: 95, y: 70 }, { x: 150, y: 70 }, { x: 150, y: 76 }, { x: 95, y: 76 }],
  ];
  const layout = fillBaysForAisles(polygon, 1, {
    ...OPTIONS,
    gates: [{ type: 'entry', point: { x: 160, y: 73 } }],
  }, roads);
  finiteLayout(layout);
  assert.equal(layout.metadata.connectivity.connected, true);
  assert.equal(layout.metadata.connectivity.selectedBy, 'entry-gate');
  assert.equal(layout.metadata.connectivity.aisleComponentsBefore, 2);
  assert.equal(layout.aisles.length, 1);
  assert.ok(layout.aisles[0].every((point) => point.x >= 95), 'component nearest the entry should be retained');
  const warning = layout.metadata.warnings.find((item) => item.code === 'DISCONNECTED_NETWORK_PRUNED');
  assert.ok(warning);
  assert.equal(warning.selectedBy, 'entry-gate');
  assert.ok(warning.aisles > 0 && warning.stalls > 0);
});

test('a rotated edited road generates finite accessible stalls', () => {
  const polygon = rectangle(120, 120);
  const layout = fillBaysForAisles(polygon, 1, OPTIONS, [rotatedRoad(60, 60, 70, 6, Math.PI / 4)]);
  finiteLayout(layout);
  assert.ok(layout.count > 0);
  assert.equal(layout.metadata.strategy, 'edited-roads');
  assert.equal(layout.metadata.connectivity.connected, true);
  assertAllQuadsInside(layout, polygon);
});

test('fillEmpty never removes capacity and preserves valid metadata/geometry', () => {
  const polygon = concaveCases.C;
  const baseline = computeBestLayout(polygon, 1, OPTIONS);
  const filled = computeBestLayout(polygon, 1, { ...OPTIONS, fillEmpty: true });
  finiteLayout(baseline);
  finiteLayout(filled);
  assert.ok(filled.count >= baseline.count);
  assert.ok(filled.metadata.regionAnglesDeg.length > 0);
  assertAllQuadsInside(filled, polygon);
});

test('layout generation is deterministic', () => {
  const polygon = concaveCases.U;
  const first = computeBestLayout(polygon, 1, { ...OPTIONS, fillEmpty: true });
  const second = computeBestLayout(polygon, 1, { ...OPTIONS, fillEmpty: true });
  assert.deepEqual(second, first);
});

test('layout is invariant to coordinate scale when m/px changes inversely', () => {
  const polygon = rectangle(100, 80);
  const factor = 2;
  const scaledPolygon = polygon.map((point) => ({ x: point.x * factor, y: point.y * factor }));
  const base = computeBestLayout(polygon, 1, OPTIONS);
  const scaled = computeBestLayout(scaledPolygon, 1 / factor, OPTIONS);
  finiteLayout(base);
  finiteLayout(scaled);
  assert.equal(scaled.count, base.count);
  assert.equal(scaled.angleDeg, base.angleDeg);
  assert.equal(scaled.areaM2, base.areaM2);
  for (const key of ['stalls', 'aisles']) {
    assert.equal(scaled[key].length, base[key].length);
    for (let i = 0; i < base[key].length; i++) {
      for (let j = 0; j < 4; j++) {
        assert.ok(Math.abs(scaled[key][i][j].x / factor - base[key][i][j].x) < 1e-8);
        assert.ok(Math.abs(scaled[key][i][j].y / factor - base[key][i][j].y) < 1e-8);
      }
    }
  }
});


test('A/B candidates are finalized independently before strategy comparison', () => {
  const polygon = [
    { x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 10 }, { x: 15, y: 10 },
    { x: 15, y: 45 }, { x: 50, y: 45 }, { x: 50, y: 50 }, { x: 0, y: 50 },
  ];
  const layout = computeBestLayout(polygon, 1, OPTIONS);
  finiteLayout(layout);
  assert.ok(layout.count > 0);
  assert.equal(layout.count, 24);
  assert.equal(layout.metadata.strategy, 'single', 'decomposed raw output has no valid aisle network');
  assert.equal(layout.metadata.connectivity.connected, true);
  assertAllQuadsInside(layout, polygon);
});

test('entry gate ignores a nearer aisle hidden across a concavity', () => {
  const polygon = [
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 55, y: 100 },
    { x: 55, y: 30 }, { x: 45, y: 30 }, { x: 45, y: 100 }, { x: 0, y: 100 },
  ];
  const visibleRoad = [
    { x: 10, y: 45 }, { x: 16, y: 45 }, { x: 16, y: 90 }, { x: 10, y: 90 },
  ];
  const hiddenRoad = [
    { x: 55, y: 45 }, { x: 61, y: 45 }, { x: 61, y: 90 }, { x: 55, y: 90 },
  ];
  const gate = { x: 45, y: 80 };
  const layout = fillBaysForAisles(polygon, 1, {
    ...OPTIONS,
    gates: [{ type: 'entry', point: gate }],
  }, [visibleRoad, hiddenRoad]);

  finiteLayout(layout);
  assert.equal(layout.metadata.connectivity.selectedBy, 'entry-gate');
  assert.equal(layout.aisles.length, 1);
  assert.deepEqual(layout.aisles[0], visibleRoad);
  const access = layout.metadata.connectivity.gateAccess;
  assert.ok(access);
  assert.equal(access.aisleIndex, 0);
  assert.deepEqual(access.aisle, visibleRoad);
  assert.deepEqual(access.targetPoint, { x: 16, y: 80 });
  assert.ok(segmentInsidePolygon(gate, access.targetPoint, polygon));
  assert.equal(segmentInsidePolygon(gate, { x: 55, y: 80 }, polygon), false);
});

test('entry gate falls back to the stall-richest component when no aisle is visible', () => {
  const polygon = [
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 55, y: 100 },
    { x: 55, y: 30 }, { x: 45, y: 30 }, { x: 45, y: 100 }, { x: 0, y: 100 },
  ];
  const hiddenRoad = [
    { x: 55, y: 45 }, { x: 61, y: 45 }, { x: 61, y: 90 }, { x: 55, y: 90 },
  ];
  const layout = fillBaysForAisles(polygon, 1, {
    ...OPTIONS,
    gates: [{ type: 'entry', point: { x: 45, y: 80 } }],
  }, [hiddenRoad]);

  finiteLayout(layout);
  assert.ok(layout.count > 0);
  assert.equal(layout.metadata.connectivity.selectedBy, 'stall-count');
  assert.equal(Object.hasOwn(layout.metadata.connectivity, 'gateAccess'), false);
});

test('empty edited-road output and parcels too narrow for an aisle return null', () => {
  const tinyRoad = [
    { x: 10, y: 10 }, { x: 11, y: 10 }, { x: 11, y: 11 }, { x: 10, y: 11 },
  ];
  assert.equal(fillBaysForAisles(rectangle(40, 40), 1, OPTIONS, [tinyRoad]), null);
  assert.equal(computeBestLayout(rectangle(100, 2), 1, { ...OPTIONS, angleStepDeg: 90 }), null);
});

test('fillEmpty adds real capacity on a leftover region and remains finalized', () => {
  const polygon = [
    { x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 20 },
    { x: 20, y: 20 }, { x: 20, y: 60 }, { x: 0, y: 60 },
  ];
  const options = { ...OPTIONS, angleStepDeg: 90, backToBack: false };
  const baseline = computeBestLayout(polygon, 1, options);
  const filled = computeBestLayout(polygon, 1, { ...options, fillEmpty: true });
  finiteLayout(baseline);
  finiteLayout(filled);
  assert.equal(baseline.count, 19);
  assert.equal(filled.count, 24);
  assert.ok(filled.count > baseline.count);
  assert.equal(filled.metadata.connectivity.connected, true);
  assertAllQuadsInside(filled, polygon);
});

test('vertex and guarded work limits reject pathological public inputs', () => {
  const tooManyVertices = Array.from({ length: 513 }, (_, i) => {
    const angle = (i * Math.PI * 2) / 513;
    return { x: 100 + Math.cos(angle) * 80, y: 100 + Math.sin(angle) * 80 };
  });
  assert.equal(computeBestLayout(tooManyVertices, 1, OPTIONS), null);
  assert.equal(computeBestLayout(rectangle(300, 300), 1, {
    ...OPTIONS,
    angleStepDeg: 180,
  }), null);
});
