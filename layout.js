// layout.js — Otopark yerleşim optimizasyon motoru
// content.js ile aynı izole "world" içinde çalışır; fonksiyonlar paylaşılır.

const _LAYOUT_LIMITS = Object.freeze({
  maxVertices: 512,
  maxWork: 2500000,
  maxGridCells: 300000,
  maxAisles: 2500,
  maxStalls: 20000,
});

function _finitePoint(p) {
  return p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

function _geomEps(points) {
  let scale = 1;
  for (const p of points || []) scale = Math.max(scale, Math.abs(p.x), Math.abs(p.y));
  return scale * 1e-9;
}

function _cross(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function _pointOnSegment(p, a, b, eps) {
  eps = eps || _geomEps([p, a, b]);
  if (Math.abs(_cross(a, b, p)) > eps * Math.max(1, Math.hypot(b.x - a.x, b.y - a.y))) return false;
  return p.x >= Math.min(a.x, b.x) - eps && p.x <= Math.max(a.x, b.x) + eps &&
    p.y >= Math.min(a.y, b.y) - eps && p.y <= Math.max(a.y, b.y) + eps;
}

function _segmentsIntersect(a, b, c, d) {
  const eps = _geomEps([a, b, c, d]);
  const abC = _cross(a, b, c), abD = _cross(a, b, d);
  const cdA = _cross(c, d, a), cdB = _cross(c, d, b);
  if (((abC > eps && abD < -eps) || (abC < -eps && abD > eps)) &&
      ((cdA > eps && cdB < -eps) || (cdA < -eps && cdB > eps))) return true;
  return (Math.abs(abC) <= eps && _pointOnSegment(c, a, b, eps)) ||
    (Math.abs(abD) <= eps && _pointOnSegment(d, a, b, eps)) ||
    (Math.abs(cdA) <= eps && _pointOnSegment(a, c, d, eps)) ||
    (Math.abs(cdB) <= eps && _pointOnSegment(b, c, d, eps));
}

// Nokta poligon içinde mi? Sınır noktaları dahil ray casting.
function _pointInPoly(pt, poly) {
  if (!_finitePoint(pt) || !Array.isArray(poly) || poly.length < 3) return false;
  const eps = _geomEps(poly.concat([pt]));
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if (_pointOnSegment(pt, poly[j], poly[i], eps)) return true;
    const hit =
      yi > pt.y !== yj > pt.y &&
      pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

// Bir segmentin tamamının poligon içinde/sınırında olduğunu, tüm gerçek
// sınır kesişimlerinin arasındaki aralıkları örnekleyerek doğrular.
function _segmentInsidePoly(a, b, poly) {
  if (!_pointInPoly(a, poly) || !_pointInPoly(b, poly)) return false;
  const dx = b.x - a.x, dy = b.y - a.y;
  if (dx * dx + dy * dy === 0) return true;
  const ts = [0, 1];
  const eps = _geomEps(poly.concat([a, b]));
  const addT = (p) => {
    const t = Math.abs(dx) >= Math.abs(dy) ? (p.x - a.x) / (dx || 1) : (p.y - a.y) / (dy || 1);
    if (t >= -eps && t <= 1 + eps) ts.push(Math.max(0, Math.min(1, t)));
  };
  for (let i = 0; i < poly.length; i++) {
    const c = poly[i], d = poly[(i + 1) % poly.length];
    if (!_segmentsIntersect(a, b, c, d)) continue;
    const den = dx * (d.y - c.y) - dy * (d.x - c.x);
    if (Math.abs(den) > eps) {
      const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den;
      ts.push(Math.max(0, Math.min(1, t)));
    } else {
      if (_pointOnSegment(c, a, b, eps)) addT(c);
      if (_pointOnSegment(d, a, b, eps)) addT(d);
    }
  }
  ts.sort((x, y) => x - y);
  for (let i = 1; i < ts.length; i++) {
    if (ts[i] - ts[i - 1] <= eps) continue;
    const t = (ts[i] + ts[i - 1]) / 2;
    if (!_pointInPoly({ x: a.x + dx * t, y: a.y + dy * t }, poly)) return false;
  }
  return true;
}

function _quadInsidePoly(quad, poly) {
  if (!Array.isArray(quad) || quad.length !== 4 || quad.some((p) => !_finitePoint(p))) return false;
  for (let i = 0; i < 4; i++) {
    if (!_segmentInsidePoly(quad[i], quad[(i + 1) % 4], poly)) return false;
  }
  return true;
}

function _pointSegmentDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const den = dx * dx + dy * dy;
  const t = den ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / den)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

function _pointToQuadDistance(p, quad) {
  if (_pointInPoly(p, quad)) return 0;
  let best = Infinity;
  for (let i = 0; i < quad.length; i++) best = Math.min(best, _pointSegmentDistance(p, quad[i], quad[(i + 1) % quad.length]));
  return best;
}

// Konveks, sıralı quad'lar için SAT. Yalnız gerçek alan çakışması true'dur;
// ortak kenar/tek nokta, yan yana bay ve koridorlar için çakışma sayılmaz.
function _convexQuadsOverlap(a, b) {
  const eps = _geomEps(a.concat(b));
  for (const q of [a, b]) {
    for (let i = 0; i < q.length; i++) {
      const p0 = q[i], p1 = q[(i + 1) % q.length];
      const axis = { x: -(p1.y - p0.y), y: p1.x - p0.x };
      const len = Math.hypot(axis.x, axis.y);
      if (len <= eps) continue;
      axis.x /= len; axis.y /= len;
      let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (const p of a) { const v = p.x * axis.x + p.y * axis.y; amin = Math.min(amin, v); amax = Math.max(amax, v); }
      for (const p of b) { const v = p.x * axis.x + p.y * axis.y; bmin = Math.min(bmin, v); bmax = Math.max(bmax, v); }
      if (amax <= bmin + eps || bmax <= amin + eps) return false;
    }
  }
  return true;
}

function _nearestPointOnQuad(p, quad) {
  if (!Array.isArray(quad) || !quad.length) return null;
  if (_pointInPoly(p, quad)) return { point: { x: p.x, y: p.y }, distance: 0 };
  let best = null;
  for (let i = 0; i < quad.length; i++) {
    const a = quad[i], b = quad[(i + 1) % quad.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const den = dx * dx + dy * dy;
    const t = den ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / den)) : 0;
    const point = { x: a.x + dx * t, y: a.y + dy * t };
    const distance = Math.hypot(p.x - point.x, p.y - point.y);
    if (!best || distance < best.distance) best = { point, distance };
  }
  return best;
}

function _isConvexQuad(q) {
  if (!Array.isArray(q) || q.length !== 4 || q.some((p) => !_finitePoint(p))) return false;
  const eps = _geomEps(q);
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const value = _cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4]);
    if (Math.abs(value) <= eps) return false;
    const current = Math.sign(value);
    if (sign && current !== sign) return false;
    sign = current;
  }
  return true;
}

function _quadDistance(a, b) {
  if (_convexQuadsOverlap(a, b)) return 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (_segmentsIntersect(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return 0;
    }
  }
  let best = Infinity;
  for (const p of a) for (let i = 0; i < b.length; i++) best = Math.min(best, _pointSegmentDistance(p, b[i], b[(i + 1) % b.length]));
  for (const p of b) for (let i = 0; i < a.length; i++) best = Math.min(best, _pointSegmentDistance(p, a[i], a[(i + 1) % a.length]));
  return best;
}

function _sanitizePolygon(polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3 || polygon.length > _LAYOUT_LIMITS.maxVertices + 1) return null;
  const out = [];
  for (const p of polygon) {
    if (!_finitePoint(p)) return null;
    const q = { x: Number(p.x), y: Number(p.y) };
    if (!out.length || Math.hypot(q.x - out[out.length - 1].x, q.y - out[out.length - 1].y) > _geomEps([q, out[out.length - 1]])) out.push(q);
  }
  if (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= _geomEps(out)) out.pop();
  if (out.length < 3 || out.length > _LAYOUT_LIMITS.maxVertices || !Number.isFinite(_polyAreaPx(out)) || _polyAreaPx(out) <= _geomEps(out)) return null;
  let work = 0;
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      if (++work > _LAYOUT_LIMITS.maxWork) return null;
      if (j === i + 1 || (i === 0 && j === out.length - 1)) continue;
      if (_segmentsIntersect(out[i], out[(i + 1) % out.length], out[j], out[(j + 1) % out.length])) return null;
    }
  }
  return out;
}

function _sanitizeOptions(opts, includeAngle) {
  const src = opts && typeof opts === "object" ? opts : {};
  const defaults = { stallWidthM: 2.5, stallDepthM: 5.0, aisleWidthM: 6.0, angleStepDeg: 10 };
  const out = Object.assign({}, src);
  for (const key of ["stallWidthM", "stallDepthM", "aisleWidthM"]) {
    const value = src[key] === undefined ? defaults[key] : Number(src[key]);
    if (!Number.isFinite(value) || value <= 0 || value > 1000) return null;
    out[key] = value;
  }
  if (includeAngle || src.angleStepDeg !== undefined) {
    const angle = src.angleStepDeg === undefined ? defaults.angleStepDeg : Number(src.angleStepDeg);
    if (!Number.isFinite(angle) || angle < 0.5 || angle > 180) return null;
    out.angleStepDeg = angle;
  }
  out.backToBack = src.backToBack !== false;
  out.fillEmpty = src.fillEmpty === true;
  out.gates = Array.isArray(src.gates) ? src.gates
    .filter((g) => g && _finitePoint(g.point))
    .slice(0, 32)
    .map((g) => ({ type: g.type === "entry" || g.type === "exit" ? g.type : undefined, point: { x: Number(g.point.x), y: Number(g.point.y) } })) : [];
  return out;
}

function _newBudget() {
  return { used: 0, max: _LAYOUT_LIMITS.maxWork };
}

function _spend(budget, amount) {
  budget.used += amount || 1;
  if (budget.used > budget.max) {
    const error = new Error("layout work budget exceeded");
    error.code = "LAYOUT_WORK_BUDGET";
    throw error;
  }
}

// Noktayı c merkezi etrafında ang radyan döndürür.
function _rotate(pt, ang, c) {
  const cos = Math.cos(ang), sin = Math.sin(ang);
  const dx = pt.x - c.x, dy = pt.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

// Poligon alanı (piksel², shoelace).
function _polyAreaPx(poly) {
  let a2 = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a2 += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a2) / 2;
}

function _polyBounds(poly) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function _rectCorners(x0, y0, x1, y1) {
  return [
    { x: x0, y: y0 }, { x: x1, y: y0 },
    { x: x1, y: y1 }, { x: x0, y: y1 },
  ];
}

function _rectInsidePoly(x0, y0, x1, y1, poly) {
  return _quadInsidePoly(_rectCorners(x0, y0, x1, y1), poly);
}

function _distancePointToRect(pt, rect) {
  const x0 = Math.min(rect.x0, rect.x1), x1 = Math.max(rect.x0, rect.x1);
  const y0 = Math.min(rect.y0, rect.y1), y1 = Math.max(rect.y0, rect.y1);
  const dx = pt.x < x0 ? x0 - pt.x : pt.x > x1 ? pt.x - x1 : 0;
  const dy = pt.y < y0 ? y0 - pt.y : pt.y > y1 ? pt.y - y1 : 0;
  return Math.hypot(dx, dy);
}

function _rectsOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function _bboxOfPoints(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// Tek yön + tek faz ile bir poligonu yerleştirir (çekirdek motor).
function _layoutSingle(polygon, mpp, opts) {
  if (!polygon || polygon.length < 3 || !Number.isFinite(mpp) || mpp <= 0 || !opts) return null;
  const budget = opts._budget || _newBudget();

  const pxPerM = 1 / mpp;
  const sw = opts.stallWidthM * pxPerM;   // bay genişliği (px)
  const sd = opts.stallDepthM * pxPerM;   // bay derinliği (px)
  const aw = opts.aisleWidthM * pxPerM;   // koridor genişliği (px)
  const gates = Array.isArray(opts.gates) ? opts.gates.filter((g) => g && g.point) : [];
  const backToBack = opts.backToBack !== false;
  const gateClearance = Math.max(aw * 1.35, sd * 1.1);

  // Döndürme ekseni: poligon ağırlık merkezi
  let cx = 0, cy = 0;
  for (const p of polygon) { cx += p.x; cy += p.y; }
  cx /= polygon.length; cy /= polygon.length;
  const c = { x: cx, y: cy };

  function bayBlockedByGate(bay, rgates) {
    const s = baySize(bay);
    const quad = bay.corners || _rectCorners(bay.x, bay.y, bay.x + s.w, bay.y + s.h);
    return rgates.some((gate) => _pointToQuadDistance(gate.point, quad) < gateClearance);
  }

  function rangesOverlap(a0, a1, b0, b1) {
    return a0 < b1 && b0 < a1;
  }

  // Bir yatay koridor satırını (aisleY) poligon içinde maksimal SEGMENTLERE böler.
  // Konkav/girintili alanda bir satır birden çok parçaya ayrılır; HEPSİ korunur.
  // Her segment kendi park baylarını (alt + üst sıra) taşır.
  function horizontalSegments(rpoly, aisleY, offX, rgates) {
    const { minX, maxX } = _polyBounds(rpoly);
    const segs = [];
    let run = null;
    const close = () => {
      if (run && run.bays.length) { run.x1 = run.lastX + sw; segs.push(run); }
      run = null;
    };
    for (let x = minX - offX; x + sw <= maxX; x += sw) {
      _spend(budget);
      if (!_rectInsidePoly(x, aisleY, x + sw, aisleY + aw, rpoly)) { close(); continue; }
      if (!run) run = { x0: x, lastX: x, y0: aisleY, y1: aisleY + aw, bays: [] };
      run.lastX = x;
      const lower = { x, y: aisleY - sd };
      const upper = { x, y: aisleY + aw };
      if (_rectInsidePoly(x, aisleY - sd, x + sw, aisleY, rpoly) && !bayBlockedByGate(lower, rgates)) run.bays.push(lower);
      if (_rectInsidePoly(x, aisleY + aw, x + sw, aisleY + aw + sd, rpoly) && !bayBlockedByGate(upper, rgates)) run.bays.push(upper);
    }
    close();
    return segs;
  }

  // Dikey bağlayıcı yolu (xc'de, genişlik aw) poligon içinde maksimal segmentlere böler.
  function verticalSegments(rpoly, xc) {
    const { minY, maxY } = _polyBounds(rpoly);
    const step = sd;
    const segs = [];
    let y0 = null, lastY = null;
    const close = () => {
      if (y0 !== null && (lastY + step - y0) >= aw) segs.push({ x0: xc, x1: xc + aw, y0, y1: lastY + step });
      y0 = null; lastY = null;
    };
    for (let y = minY; y + step <= maxY; y += step) {
      _spend(budget);
      if (!_rectInsidePoly(xc, y, xc + aw, y + step, rpoly)) { close(); continue; }
      if (y0 === null) y0 = y;
      lastY = y;
    }
    close();
    return segs;
  }

  // Dik bağlayıcı için aday x konumları: düzenli aralık + segment uçları + kapılar.
  function connectorXs(rpoly, hsegs, rgates) {
    const { minX, maxX } = _polyBounds(rpoly);
    if (maxX - minX < aw) return [];
    const snap = Math.max(1, sw * 0.5);
    const set = new Set();
    const add = (x) => { if (x >= minX && x + aw <= maxX) set.add(Math.round(x / snap) * snap); };
    const spacing = Math.max(aw * 3, (aw + 2 * sd) * 1.4);
    for (let x = minX; x + aw <= maxX; x += spacing) add(x);
    add(maxX - aw);
    for (const s of hsegs) { add(s.x0 - aw); add(s.x1); add(s.x0); add(s.x1 - aw); }
    for (const g of rgates) add(g.point.x - aw / 2);
    return Array.from(set);
  }

  function candidateStackStarts(rpoly, rgates) {
    const { minY, maxY } = _polyBounds(rpoly);
    const moduleDepth = aw + (backToBack ? 2 * sd : sd);
    const span = maxY - minY;
    if (span < aw) return [];

    const values = new Set();
    const add = (y) => {
      if (y >= minY && y + aw <= maxY) values.add(Math.round(y * 1000) / 1000);
    };

    add(minY);
    add(minY + sd);
    add((minY + maxY - aw) / 2);
    add(maxY - aw - sd);
    add(maxY - aw);
    for (const gate of rgates) {
      add(gate.point.y - aw / 2);
      add(gate.point.y - aw);
      add(gate.point.y - sd - aw);
    }

    const steps = 8;
    const phaseSpan = Math.min(moduleDepth, Math.max(0, span - aw));
    for (let i = 0; i <= steps; i++) add(minY + (phaseSpan * i) / steps);
    return Array.from(values);
  }

  // Çok-segmentli yatay koridorlar üretir, ardından AYRI segmentleri birleştiren
  // minimal dik bağlayıcılarla (union-find spanning) bağlı bir sürüş ağı kurar.
  // Konkav/girintili alanlarda her parça korunur; tek koridorluya da düşebilir.
  function generateStack(rpoly, startY, offX, rgates) {
    const { minY, maxY } = _polyBounds(rpoly);
    const moduleDepth = aw + (backToBack ? 2 * sd : sd);

    const hsegs = [];
    for (let y = startY; y + aw <= maxY; y += moduleDepth) {
      for (const s of horizontalSegments(rpoly, y, offX, rgates)) hsegs.push(s);
    }
    for (let y = startY - moduleDepth; y >= minY; y -= moduleDepth) {
      for (const s of horizontalSegments(rpoly, y, offX, rgates)) hsegs.push(s);
    }
    if (!hsegs.length) return { count: 0, bays: [], aisles: [] };

    // Dik bağlayıcı adayları → her birinin kestiği yatay segmentler.
    const vAll = [];
    for (const xc of connectorXs(rpoly, hsegs, rgates)) {
      for (const v of verticalSegments(rpoly, xc)) vAll.push(v);
    }
    const cross = vAll.map((v) => {
      _spend(budget, hsegs.length);
      const hits = [];
      for (let i = 0; i < hsegs.length; i++) {
        const h = hsegs[i];
        if (rangesOverlap(v.x0, v.x1, h.x0, h.x1) && rangesOverlap(v.y0, v.y1, h.y0, h.y1)) hits.push(i);
      }
      return hits;
    });

    // Spanning: yalnızca farklı bileşenleri birleştiren bağlayıcıları seç (minimal).
    const parent = hsegs.map((_, i) => i);
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) { parent[ra] = rb; return true; } return false; };
    const order = vAll.map((_, i) => i).sort((a, b) => cross[b].length - cross[a].length);
    const chosen = [];
    for (const vi of order) {
      const hits = cross[vi];
      if (hits.length < 2) continue;
      let merged = false;
      for (let k = 1; k < hits.length; k++) { if (union(hits[0], hits[k])) merged = true; }
      if (merged) chosen.push(vAll[vi]);
    }

    const connRects = chosen.map((v) => ({ x: v.x0, y: v.y0, w: v.x1 - v.x0, h: v.y1 - v.y0 }));
    const bays = [];
    for (const h of hsegs) {
      for (const b of h.bays) {
        if (connRects.some((cr) => _rectsOverlap({ x: b.x, y: b.y, w: sw, h: sd }, cr))) continue;
        bays.push(b);
      }
    }
    const aisles = hsegs
      .map((h) => ({ x0: h.x0, y0: h.y0, x1: h.x1, y1: h.y1 }))
      .concat(chosen.map((v) => ({ x0: v.x0, y0: v.y0, x1: v.x1, y1: v.y1 })));
    return { count: bays.length, bays, aisles };
  }

  function rotatedLayout(layout, ang) {
    const stalls = layout.bays.map((b) => {
      if (b.corners) return b.corners.map((p) => _rotate(p, ang, c));
      const s = baySize(b);
      const cs = _rectCorners(b.x, b.y, b.x + s.w, b.y + s.h);
      return cs.map((p) => _rotate(p, ang, c));
    });
    const aisles = layout.aisles.map((a) => {
      const cs = _rectCorners(a.x0, a.y0, a.x1, a.y1);
      return cs.map((p) => _rotate(p, ang, c));
    });
    return { stalls, aisles };
  }

  function baySize(bay) {
    if (bay.corners) {
      const b = _bboxOfPoints(bay.corners);
      return { w: b.w, h: b.h };
    }
    return bay.vertical ? { w: sd, h: sw } : { w: sw, h: sd };
  }

  function rectOfBay(bay) {
    if (bay.corners) return _bboxOfPoints(bay.corners);
    const s = baySize(bay);
    return { x: bay.x, y: bay.y, w: s.w, h: s.h };
  }

  function addBayIfClear(bays, aisles, bay, rpoly, rgates) {
    _spend(budget, rpoly.length + rgates.length + 1);
    const s = baySize(bay);
    const quad = bay.corners || _rectCorners(bay.x, bay.y, bay.x + s.w, bay.y + s.h);
    if (!_quadInsidePoly(quad, rpoly) || bayBlockedByGate(bay, rgates)) return;
    for (const existing of bays) {
      _spend(budget);
      const es = baySize(existing);
      const eq = existing.corners || _rectCorners(existing.x, existing.y, existing.x + es.w, existing.y + es.h);
      if (_convexQuadsOverlap(quad, eq)) return;
    }
    for (const aisle of aisles) {
      _spend(budget);
      if (_convexQuadsOverlap(quad, _rectCorners(aisle.x0, aisle.y0, aisle.x1, aisle.y1))) return;
    }
    bays.push(bay);
  }

  function centroidOfCorners(corners) {
    let x = 0, y = 0;
    for (const p of corners) { x += p.x; y += p.y; }
    return { x: x / corners.length, y: y / corners.length };
  }

  function addPerimeterBays(layout, rpoly, rgates, offX) {
    const bays = [];
    const innerBays = layout.bays.slice();
    const bounds = _polyBounds(rpoly);
    // Eğik kenarlar dahil yeterince uzun tüm kenarlara çevre bayı dene.
    const minEdgeLen = sw * 4;
    const nearAnyAisle = (point, threshold) => {
      for (const al of layout.aisles) {
        _spend(budget);
        if (_distancePointToRect(point, { x0: al.x0, y0: al.y0, x1: al.x1, y1: al.y1 }) < threshold) return true;
      }
      return false;
    };
    for (let i = 0; i < rpoly.length; i++) {
      _spend(budget);
      const a = rpoly[i], b = rpoly[(i + 1) % rpoly.length];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < minEdgeLen) continue;

      const ux = dx / len, uy = dy / len;
      const normals = [
        { x: -uy, y: ux },
        { x: uy, y: -ux },
      ];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      let inward = null;
      for (const normal of normals) {
        _spend(budget, rpoly.length);
        if (_pointInPoly({ x: mid.x + normal.x * sd * 0.65, y: mid.y + normal.y * sd * 0.65 }, rpoly)) {
          inward = normal;
          break;
        }
      }
      if (!inward) continue;
      // Kenarın HİÇBİR yerinde koridor yoksa kenarı tümden atla (ucuz ön-eleme).
      const edgeProbe = { x: mid.x + inward.x * (sd + aw * 0.5), y: mid.y + inward.y * (sd + aw * 0.5) };
      if (!nearAnyAisle(edgeProbe, len / 2 + aw)) continue;

      for (let t = 0; t + sw <= len; t += sw) {
        _spend(budget);
        const p0 = { x: a.x + ux * t, y: a.y + uy * t };
        const p1 = { x: a.x + ux * (t + sw), y: a.y + uy * (t + sw) };
        const p2 = { x: p1.x + inward.x * sd, y: p1.y + inward.y * sd };
        const p3 = { x: p0.x + inward.x * sd, y: p0.y + inward.y * sd };
        // HER BAY için ayrı erişim: iç kenarı bir koridora NEREDEYSE TEMAS etmeli
        // (boşluk ~1 m'den fazlaysa ölü şerit oluşur → bayı ekleme).
        const innerMid = { x: (p2.x + p3.x) / 2, y: (p2.y + p3.y) / 2 };
        const probe = { x: innerMid.x + inward.x * (aw * 0.05), y: innerMid.y + inward.y * (aw * 0.05) };
        if (!nearAnyAisle(probe, aw * 0.15)) continue;
        addBayIfClear(bays, layout.aisles, { corners: [p0, p1, p2, p3] }, rpoly, rgates);
      }
    }
    for (const bay of innerBays) {
      _spend(budget);
      addBayIfClear(bays, layout.aisles, bay, rpoly, rgates);
    }

    return { count: bays.length, bays, aisles: layout.aisles };
  }

  function scoreLayout(layout, rgates) {
    if (!layout || !layout.count) return -Infinity;
    const aisleLength = layout.aisles.reduce((sum, a) =>
      sum + Math.max(Math.abs(a.x1 - a.x0), Math.abs(a.y1 - a.y0)), 0);
    let gatePenalty = 0;
    for (const gate of rgates) {
      let bestDist = Infinity;
      for (const aisle of layout.aisles) {
        bestDist = Math.min(bestDist, _distancePointToRect(gate.point, aisle));
      }
      gatePenalty += bestDist;
    }
    return layout.count * 100000 - aisleLength - gatePenalty * 250;
  }

  // Açı + koridor fazı (startY) + x-fazı taraması. Arama sırasında yalnızca iç
  // ağ skorlanır (hızlı); çevre bayları yalnızca KAZANAN düzene bir kez eklenir.
  let best = null;
  const OX = 3;
  for (let aDeg = 0; aDeg < 180; aDeg += opts.angleStepDeg) {
    _spend(budget, polygon.length);
    const ang = (aDeg * Math.PI) / 180;
    const rpoly = polygon.map((p) => _rotate(p, -ang, c));
    const rgates = gates.map((g) => ({ type: g.type, point: _rotate(g.point, -ang, c) }));
    for (const startY of candidateStackStarts(rpoly, rgates)) {
      for (let ix = 0; ix < OX; ix++) {
        const offX = (sw * ix) / OX;
        const base = generateStack(rpoly, startY, offX, rgates);
        if (!base.count) continue;
        const score = scoreLayout(base, rgates);
        if (!best || score > best.score) {
          best = { score, ang, aDeg, rpoly, rgates, offX, base };
        }
      }
    }
  }

  if (!best) return null;
  const final = addPerimeterBays(best.base, best.rpoly, best.rgates, best.offX);
  const { stalls, aisles } = rotatedLayout(final, best.ang);

  const areaM2 = _polyAreaPx(polygon) * mpp * mpp;
  return { count: final.count, angleDeg: best.aDeg, stalls, aisles, areaM2, opts };
}

// Binary ızgarada (1 = boş) en büyük tüm-1 dikdörtgeni (histogram yöntemi).
function _largestRect(grid, R, C, budget) {
  const h = new Array(C).fill(0);
  let best = null;
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      _spend(budget);
      h[c] = grid[r * C + c] ? h[c] + 1 : 0;
    }
    const stack = [];
    for (let c = 0; c <= C; c++) {
      _spend(budget);
      const cur = c < C ? h[c] : 0;
      let start = c;
      while (stack.length && stack[stack.length - 1].h > cur) {
        _spend(budget);
        const top = stack.pop();
        const area = top.h * (c - top.i);
        if (!best || area > best.area) best = { area, r0: r - top.h + 1, r1: r + 1, c0: top.i, c1: c };
        start = top.i;
      }
      stack.push({ i: start, h: cur });
    }
  }
  return best;
}

// Bir bayın tamamı (köşeler merkeze hafif çekilmiş + merkez) poligon içinde mi?
function _bayInside(st, poly) {
  return _quadInsidePoly(st, poly);
}

// Poligonu büyük dikdörtgenlere ayırıp (greedy largest-rectangle) her birini
// kendi yön+fazıyla yerleştirir. İnce şerit / girinti gibi farklı faz isteyen
// bölgeler ana ızgaraya feda edilmeden dolar.
function _decomposeLayout(polygon, mpp, opts) {
  const budget = opts._budget || _newBudget();
  const pxPerM = 1 / mpp;
  const sw = opts.stallWidthM * pxPerM;
  const sd = opts.stallDepthM * pxPerM;
  const aw = opts.aisleWidthM * pxPerM;
  const minBand = sd + aw;

  const b = _polyBounds(polygon);
  const cell = Math.max(4, sd * 0.35);
  const C = Math.ceil((b.maxX - b.minX) / cell);
  const R = Math.ceil((b.maxY - b.minY) / cell);
  if (C < 2 || R < 2 || C * R > _LAYOUT_LIMITS.maxGridCells) return null;

  const grid = new Uint8Array(R * C);
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      _spend(budget);
      const p = { x: b.minX + (c + 0.5) * cell, y: b.minY + (r + 0.5) * cell };
      grid[r * C + c] = _pointInPoly(p, polygon) ? 1 : 0;
    }
  }

  const rects = [];
  for (let it = 0; it < 12 && rects.length < 6; it++) {
    const rc = _largestRect(grid, R, C, budget);
    if (!rc) break;
    for (let r = rc.r0; r < rc.r1; r++) {
      for (let c = rc.c0; c < rc.c1; c++) {
        _spend(budget);
        grid[r * C + c] = 0;
      }
    }
    const rx0 = b.minX + rc.c0 * cell, rx1 = b.minX + rc.c1 * cell;
    const ry0 = b.minY + rc.r0 * cell, ry1 = b.minY + rc.r1 * cell;
    if (Math.min(rx1 - rx0, ry1 - ry0) < minBand * 0.95) continue;
    // Izgara kırpmasını ve tam-sınır knife-edge'ini telafi için biraz büyüt;
    // taşan baylar _bayInside ile kırpılır.
    const ex = cell * 1.5;
    const x0 = Math.max(b.minX, rx0 - ex), x1 = Math.min(b.maxX, rx1 + ex);
    const y0 = Math.max(b.minY, ry0 - ex), y1 = Math.min(b.maxY, ry1 + ex);
    rects.push([{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]);
  }
  if (!rects.length) return null;

  const stalls = [], aisles = [], quads = [], regionAnglesDeg = [];
  const ov = (q) => {
    for (const existing of quads) {
      _spend(budget);
      if (_convexQuadsOverlap(q, existing)) return true;
    }
    return false;
  };
  for (const rect of rects) {
    _spend(budget);
    const r = _layoutSingle(rect, mpp, opts);
    if (!r) continue;
    let accepted = 0;
    for (const st of r.stalls) {
      _spend(budget, polygon.length);
      if (_bayInside(st, polygon) && !ov(st)) {
        stalls.push(st);
        quads.push(st);
        accepted++;
      }
    }
    for (const al of r.aisles) {
      _spend(budget, polygon.length);
      if (_quadInsidePoly(al, polygon) && !ov(al)) {
        aisles.push(al);
        quads.push(al);
      }
    }
    if (accepted) regionAnglesDeg.push({ angleDeg: r.angleDeg, stalls: accepted });
  }
  if (!stalls.length) return null;
  const dominant = regionAnglesDeg.slice().sort((a, b) => b.stalls - a.stalls)[0];
  return { count: stalls.length, stalls, aisles, angleDeg: dominant ? dominant.angleDeg : 0, regionAnglesDeg };
}

// En verimli park yerleşimini hesaplar. Tek-yön/faz çözümü (A) ile bölgesel
// ayrıştırma (B) hesaplanır; daha çok bay üreten seçilir. Böylece döndürülmüş
// konveks parseller tek-yönde, ince şerit/girintili parseller B'de kazanır.
//   Döndürür: { count, angleDeg, stalls:[[{x,y}*4]], aisles:[[{x,y}*4]], areaM2, opts }
function computeBestLayout(polygon, mpp, opts) {
  polygon = _sanitizePolygon(polygon);
  opts = _sanitizeOptions(opts, true);
  if (!polygon || !opts || !Number.isFinite(mpp) || mpp <= 0 || mpp > 1000000) return null;
  Object.defineProperty(opts, "_budget", { value: _newBudget(), enumerable: false });

  const areaM2 = _polyAreaPx(polygon) * mpp * mpp;
  const finalizeCandidate = (raw, strategy) => {
    if (!raw || !raw.stalls || !raw.stalls.length || !raw.aisles || !raw.aisles.length) return null;
    const regionAnglesDeg = strategy === "decomposed"
      ? (raw.regionAnglesDeg || []).slice()
      : [{ angleDeg: raw.angleDeg, stalls: raw.count }];
    const dominant = regionAnglesDeg.slice().sort((a, b) => b.stalls - a.stalls)[0];
    const finalized = _finalizeLayout({
      count: raw.stalls.length,
      angleDeg: dominant ? dominant.angleDeg : raw.angleDeg,
      stalls: raw.stalls,
      aisles: raw.aisles,
      areaM2,
      opts,
      metadata: { strategy, regionAnglesDeg },
    }, polygon, mpp, opts);
    return finalized && finalized.count > 0 && finalized.aisles.length > 0 ? finalized : null;
  };

  // Ana çözüm zorunludur. Bölgesel ve fill aşamaları opsiyoneldir: ortak iş
  // bütçesini tüketmeleri, daha önce doğrulanmış geçerli sonucu yok etmez.
  let A = null;
  try { A = finalizeCandidate(_layoutSingle(polygon, mpp, opts), "single"); } catch (e) { return null; }

  let B = null;
  try { B = finalizeCandidate(_decomposeLayout(polygon, mpp, opts), "decomposed"); } catch (e) { B = null; }
  let selected = B && (!A || B.count > A.count) ? B : A;
  if (!selected) return null;

  // Fill yalnız geçerli ve bağlantısı doğrulanmış kazanan üzerinde çalışır;
  // eklenen geometri de public sonuca dönmeden yeniden finalize edilir.
  if (opts.fillEmpty) {
    const beforeFill = selected;
    try {
      const filled = _fillEmpty(polygon, mpp, opts, {
        stalls: selected.stalls,
        aisles: selected.aisles,
        regionAnglesDeg: selected.metadata.regionAnglesDeg,
      });
      const regionAnglesDeg = (filled && filled.regionAnglesDeg) || selected.metadata.regionAnglesDeg;
      const dominant = regionAnglesDeg.slice().sort((a, b) => b.stalls - a.stalls)[0];
      const finalized = _finalizeLayout({
        count: filled ? filled.stalls.length : selected.count,
        angleDeg: dominant ? dominant.angleDeg : selected.angleDeg,
        stalls: filled ? filled.stalls : selected.stalls,
        aisles: filled ? filled.aisles : selected.aisles,
        areaM2,
        opts,
        metadata: { strategy: selected.metadata.strategy, regionAnglesDeg },
      }, polygon, mpp, opts);
      if (finalized && finalized.count >= beforeFill.count) {
        const priorWarnings = beforeFill.metadata.warnings || [];
        const newWarnings = finalized.metadata.warnings || [];
        finalized.metadata.warnings = priorWarnings.concat(newWarnings);
        selected = finalized;
      }
    } catch (e) {
      selected = beforeFill;
    }
  }
  return selected && selected.count > 0 && selected.aisles.length > 0 ? selected : null;
}

// Mevcut yerleşimin kaplamadığı büyük boş dikdörtgenleri bulup her birini
// kendi yön/fazıyla doldurur ve sonuca EKLER (değiştirmez). isteğe bağlı.
function _fillEmpty(polygon, mpp, opts, layout) {
  const budget = opts._budget || _newBudget();
  const pxPerM = 1 / mpp;
  const sd = opts.stallDepthM * pxPerM;
  const aw = opts.aisleWidthM * pxPerM;
  const sw = opts.stallWidthM * pxPerM;
  const minBand = sd + aw;

  const b = _polyBounds(polygon);
  const cell = Math.max(4, sd * 0.4);
  const C = Math.ceil((b.maxX - b.minX) / cell);
  const R = Math.ceil((b.maxY - b.minY) / cell);
  if (C < 2 || R < 2 || C * R > _LAYOUT_LIMITS.maxGridCells) return layout;

  const grid = new Uint8Array(R * C);
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      _spend(budget);
      const p = { x: b.minX + (c + 0.5) * cell, y: b.minY + (r + 0.5) * cell };
      grid[r * C + c] = _pointInPoly(p, polygon) ? 1 : 0;
    }
  }
  const markCov = (quad) => {
    const bb = _bboxOfPoints(quad);
    const c0 = Math.max(0, Math.floor((bb.x - b.minX) / cell));
    const c1 = Math.min(C - 1, Math.floor((bb.x + bb.w - b.minX) / cell));
    const r0 = Math.max(0, Math.floor((bb.y - b.minY) / cell));
    const r1 = Math.min(R - 1, Math.floor((bb.y + bb.h - b.minY) / cell));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        _spend(budget);
        grid[r * C + c] = 0;
      }
    }
  };
  for (const s of layout.stalls) {
    _spend(budget);
    markCov(s);
  }
  for (const a of layout.aisles) {
    _spend(budget);
    markCov(a);
  }

  const stalls = layout.stalls.slice();
  const aisles = layout.aisles.slice();
  const quads = stalls.concat(aisles).slice();
  const regionAnglesDeg = (layout.regionAnglesDeg || []).slice();
  const ov = (q) => {
    for (const existing of quads) {
      _spend(budget);
      if (_convexQuadsOverlap(q, existing)) return true;
    }
    return false;
  };

  for (let it = 0; it < 8; it++) {
    const rc = _largestRect(grid, R, C, budget);
    if (!rc) break;
    for (let r = rc.r0; r < rc.r1; r++) {
      for (let c = rc.c0; c < rc.c1; c++) {
        _spend(budget);
        grid[r * C + c] = 0;
      }
    }
    const rx0 = b.minX + rc.c0 * cell, rx1 = b.minX + rc.c1 * cell;
    const ry0 = b.minY + rc.r0 * cell, ry1 = b.minY + rc.r1 * cell;
    if (Math.min(rx1 - rx0, ry1 - ry0) < minBand * 0.95) continue;
    const ex = cell * 1.5;
    const x0 = Math.max(b.minX, rx0 - ex), x1 = Math.min(b.maxX, rx1 + ex);
    const y0 = Math.max(b.minY, ry0 - ex), y1 = Math.min(b.maxY, ry1 + ex);
    const sub = _layoutSingle([{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], mpp, opts);
    if (!sub) continue;
    let accepted = 0;
    for (const st of sub.stalls) {
      _spend(budget, polygon.length);
      if (_bayInside(st, polygon) && !ov(st)) {
        stalls.push(st);
        quads.push(st);
        accepted++;
      }
    }
    for (const al of sub.aisles) {
      _spend(budget, polygon.length);
      if (_quadInsidePoly(al, polygon) && !ov(al)) {
        aisles.push(al);
        quads.push(al);
      }
    }
    if (accepted) regionAnglesDeg.push({ angleDeg: sub.angleDeg, stalls: accepted });
  }
  return { count: stalls.length, stalls, aisles, regionAnglesDeg };
}

// Koridor graph'ını bileşenlere ayırır. Giriş varsa ona en yakın koridorun
// bileşeni; yoksa erişebildiği stall sayısı en yüksek bileşen tutulur.
function _finalizeLayout(layout, polygon, mpp, opts) {
  const budget = opts._budget || _newBudget();
  const inputAisles = Array.isArray(layout.aisles) ? layout.aisles : [];
  const inputStalls = Array.isArray(layout.stalls) ? layout.stalls : [];
  if (!inputAisles.length || !inputStalls.length ||
      inputAisles.length > _LAYOUT_LIMITS.maxAisles || inputStalls.length > _LAYOUT_LIMITS.maxStalls) return null;

  const warnings = [];
  let aisles = [];
  let stalls = [];
  for (const q of inputAisles) {
    _spend(budget, polygon.length);
    if (_quadInsidePoly(q, polygon)) aisles.push(q);
  }
  for (const q of inputStalls) {
    _spend(budget, polygon.length);
    if (_quadInsidePoly(q, polygon)) stalls.push(q);
  }
  const outsideAisles = inputAisles.length - aisles.length;
  const outsideStalls = inputStalls.length - stalls.length;
  if (outsideAisles || outsideStalls) warnings.push({
    code: "OUTSIDE_POLYGON_PRUNED",
    aisles: outsideAisles,
    stalls: outsideStalls,
  });
  if (!aisles.length || !stalls.length) return null;

  const n = aisles.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    _spend(budget);
    while (parent[x] !== x) {
      _spend(budget);
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    a = find(a); b = find(b);
    if (a !== b) parent[b] = a;
  };
  const bounds = [];
  for (const aisle of aisles) {
    _spend(budget);
    bounds.push(_bboxOfPoints(aisle));
  }
  const connectEps = Math.max(1e-6, 0.02 / mpp);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      _spend(budget);
      const a = bounds[i], b = bounds[j];
      if (a.x > b.x + b.w + connectEps || b.x > a.x + a.w + connectEps ||
          a.y > b.y + b.h + connectEps || b.y > a.y + a.h + connectEps) continue;
      if (_quadDistance(aisles[i], aisles[j]) <= connectEps) union(i, j);
    }
  }

  const roots = [];
  for (let i = 0; i < n; i++) roots.push(find(i));
  const attachment = new Array(stalls.length).fill(-1);
  const stallCounts = new Map();
  const accessEps = Math.max(1e-6, 0.15 / mpp);
  for (let s = 0; s < stalls.length; s++) {
    _spend(budget);
    const sb = _bboxOfPoints(stalls[s]);
    let best = -1, bestDist = Infinity;
    for (let i = 0; i < n; i++) {
      _spend(budget);
      const ab = bounds[i];
      if (sb.x > ab.x + ab.w + accessEps || ab.x > sb.x + sb.w + accessEps ||
          sb.y > ab.y + ab.h + accessEps || ab.y > sb.y + sb.h + accessEps) continue;
      const d = _quadDistance(stalls[s], aisles[i]);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    if (best >= 0 && bestDist <= accessEps) {
      attachment[s] = best;
      const root = roots[best];
      stallCounts.set(root, (stallCounts.get(root) || 0) + 1);
    }
  }

  const componentRoots = Array.from(new Set(roots));
  componentRoots.sort((a, b) => (stallCounts.get(b) || 0) - (stallCounts.get(a) || 0) || a - b);
  let keepRoot = componentRoots.length ? componentRoots[0] : -1;
  let selectedBy = "stall-count";
  let gateAccess = null;
  const entry = (opts.gates || []).find((g) => g.type === "entry");
  if (entry) {
    let nearest = null;
    for (let i = 0; i < n; i++) {
      _spend(budget, polygon.length + 1);
      const hit = _nearestPointOnQuad(entry.point, aisles[i]);
      if (!hit || !_segmentInsidePoly(entry.point, hit.point, polygon)) continue;
      if (!nearest || hit.distance < nearest.distance) nearest = { aisleIndex: i, point: hit.point, distance: hit.distance };
    }
    if (nearest) {
      keepRoot = roots[nearest.aisleIndex];
      selectedBy = "entry-gate";
      gateAccess = nearest;
    }
  }

  const oldAisles = aisles.length, oldStalls = stalls.length;
  const keepAisle = [];
  const retainedAisleIndices = [];
  const retainedAisles = [];
  for (let i = 0; i < roots.length; i++) {
    _spend(budget);
    const keep = roots[i] === keepRoot;
    keepAisle.push(keep);
    if (keep) {
      retainedAisleIndices.push(i);
      retainedAisles.push(aisles[i]);
    }
  }
  const retainedStalls = [];
  for (let i = 0; i < stalls.length; i++) {
    _spend(budget);
    if (attachment[i] >= 0 && keepAisle[attachment[i]]) retainedStalls.push(stalls[i]);
  }
  aisles = retainedAisles;
  stalls = retainedStalls;
  if (!aisles.length || !stalls.length) return null;

  if (gateAccess) {
    const aisleIndex = retainedAisleIndices.indexOf(gateAccess.aisleIndex);
    gateAccess = {
      gatePoint: { x: entry.point.x, y: entry.point.y },
      targetPoint: { x: gateAccess.point.x, y: gateAccess.point.y },
      aisleIndex,
      aisle: aisles[aisleIndex].map((point) => ({ x: point.x, y: point.y })),
      distance: gateAccess.distance,
    };
  }
  const prunedAisles = oldAisles - aisles.length;
  const prunedStalls = oldStalls - stalls.length;
  if (prunedAisles || prunedStalls) warnings.push({
    code: "DISCONNECTED_NETWORK_PRUNED",
    aisles: prunedAisles,
    stalls: prunedStalls,
    selectedBy,
  });

  const retainedRoots = new Set(retainedAisleIndices.map((i) => roots[i]));
  const connected = aisles.length > 0 && stalls.length > 0 && retainedRoots.size === 1;
  if (!connected) return null;
  const connectivity = {
    connected,
    selectedBy,
    aisleComponentsBefore: new Set(roots).size,
    retainedAisles: aisles.length,
    retainedStalls: stalls.length,
  };
  if (gateAccess) connectivity.gateAccess = gateAccess;
  const metadata = Object.assign({}, layout.metadata || {}, { warnings, connectivity });
  return Object.assign({}, layout, { count: stalls.length, stalls, aisles, metadata });
}

// Kullanıcı yolları elle taşıdıktan sonra: koridorları SABİT tutup
// park yerlerini onların uzun kenarları boyunca yeniden dizer.
//   polygon, aisleQuads, gates: hepsi ekran pikseli (4 köşeli quad'lar).
function fillBaysForAisles(polygon, mpp, opts, aisleQuads) {
  polygon = _sanitizePolygon(polygon);
  opts = _sanitizeOptions(opts, false);
  if (!polygon || !opts || !Number.isFinite(mpp) || mpp <= 0 || mpp > 1000000) return null;
  if (!Array.isArray(aisleQuads) || !aisleQuads.length || aisleQuads.length > _LAYOUT_LIMITS.maxAisles) return null;
  aisleQuads = aisleQuads
    .filter((q) => Array.isArray(q) && q.length === 4 && q.every(_finitePoint))
    .map((q) => q.map((p) => ({ x: Number(p.x), y: Number(p.y) })))
    .filter((q) => _isConvexQuad(q) && _quadInsidePoly(q, polygon));
  if (!aisleQuads.length) return null;

  const pxPerM = 1 / mpp;
  const sw = opts.stallWidthM * pxPerM;
  const sd = opts.stallDepthM * pxPerM;
  const gates = opts.gates;
  const gateClearance = Math.max(opts.aisleWidthM * pxPerM * 1.35, sd * 1.1);

  const D = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const N = (v) => { const l = Math.hypot(v.x, v.y) || 1; return { x: v.x / l, y: v.y / l }; };
  const bays = [];
  const budget = _newBudget();

  try {
    for (const q of aisleQuads) {
      const center = {
        x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4,
        y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4,
      };
      const edges = [[0, 1], [1, 2], [2, 3], [3, 0]]
        .map(([i, j]) => ({ a: q[i], b: q[j], len: D(q[i], q[j]) }))
        .sort((p, r) => r.len - p.len)
        .slice(0, 2); // en uzun iki kenar = koridorun uzun yüzleri

      for (const e of edges) {
        if (e.len < sw) continue;
        const u = N({ x: e.b.x - e.a.x, y: e.b.y - e.a.y });
        const mid = { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 };
        const n = N({ x: mid.x - center.x, y: mid.y - center.y }); // dışa doğru normal

        for (let t = 0; t + sw <= e.len + 0.01; t += sw) {
          _spend(budget);
          const p0 = { x: e.a.x + u.x * t, y: e.a.y + u.y * t };
          const p1 = { x: e.a.x + u.x * (t + sw), y: e.a.y + u.y * (t + sw) };
          const p2 = { x: p1.x + n.x * sd, y: p1.y + n.y * sd };
          const p3 = { x: p0.x + n.x * sd, y: p0.y + n.y * sd };
          const corners = [p0, p1, p2, p3];
          _spend(budget, aisleQuads.length + bays.length);
          if (bays.length >= _LAYOUT_LIMITS.maxStalls) return null;
          if (!_quadInsidePoly(corners, polygon)) continue;
          if (gates.some((g) => _pointToQuadDistance(g.point, corners) < gateClearance)) continue;
          if (aisleQuads.some((road) => _convexQuadsOverlap(corners, road))) continue;
          if (bays.some((ex) => _convexQuadsOverlap(corners, ex))) continue;
          bays.push(corners);
        }
      }
    }
  } catch (e) {
    return null;
  }

  const areaM2 = _polyAreaPx(polygon) * mpp * mpp;
  try {
    return _finalizeLayout({
      count: bays.length,
      stalls: bays,
      aisles: aisleQuads,
      areaM2,
      opts,
      metadata: { strategy: "edited-roads", regionAnglesDeg: [] },
    }, polygon, mpp, opts);
  } catch (e) {
    return null;
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { computeBestLayout, fillBaysForAisles };
}
