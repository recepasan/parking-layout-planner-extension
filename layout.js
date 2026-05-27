// layout.js — Otopark yerleşim optimizasyon motoru
// content.js ile aynı izole "world" içinde çalışır; fonksiyonlar paylaşılır.

// Nokta poligon içinde mi? (ray casting)
function _pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const hit =
      yi > pt.y !== yj > pt.y &&
      pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
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
  const corners = _rectCorners(x0, y0, x1, y1);
  for (const cor of corners) {
    if (!_pointInPoly(cor, poly)) return false;
  }
  return true;
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
  opts = Object.assign(
    { stallWidthM: 2.5, stallDepthM: 5.0, aisleWidthM: 6.0, angleStepDeg: 10 },
    opts || {}
  );
  if (!polygon || polygon.length < 3 || !mpp || !isFinite(mpp) || mpp <= 0) return null;

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
    if (bay.corners) {
      const b = _bboxOfPoints(bay.corners);
      const rect = { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h };
      return rgates.some((gate) => _distancePointToRect(gate.point, rect) < gateClearance);
    }
    const s = baySize(bay);
    const rect = { x0: bay.x, y0: bay.y, x1: bay.x + s.w, y1: bay.y + s.h };
    return rgates.some((gate) => _distancePointToRect(gate.point, rect) < gateClearance);
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
    if (bay.corners) {
      if (bayBlockedByGate(bay, rgates)) return;
      // 4 köşeyi de (merkeze %4 çekilmiş — sınır hassasiyeti için) + merkez test et.
      const ctr = centroidOfCorners(bay.corners);
      const probes = bay.corners.map((p) => ({ x: p.x + (ctr.x - p.x) * 0.04, y: p.y + (ctr.y - p.y) * 0.04 }));
      probes.push(ctr);
      for (const p of probes) {
        if (!_pointInPoly(p, rpoly)) return;
      }
      const rect = rectOfBay(bay);
      for (const existing of bays) {
        if (_rectsOverlap(rect, rectOfBay(existing))) return;
      }
      for (const aisle of aisles) {
        if (_rectsOverlap(rect, { x: aisle.x0, y: aisle.y0, w: aisle.x1 - aisle.x0, h: aisle.y1 - aisle.y0 })) return;
      }
      bays.push(bay);
      return;
    }
    const s = baySize(bay);
    if (!_rectInsidePoly(bay.x, bay.y, bay.x + s.w, bay.y + s.h, rpoly)) return;
    if (bayBlockedByGate(bay, rgates)) return;
    const rect = rectOfBay(bay);
    for (const existing of bays) {
      if (_rectsOverlap(rect, rectOfBay(existing))) return;
    }
    for (const aisle of aisles) {
      if (_rectsOverlap(rect, { x: aisle.x0, y: aisle.y0, w: aisle.x1 - aisle.x0, h: aisle.y1 - aisle.y0 })) return;
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
    const spanX = bounds.maxX - bounds.minX;
    const spanY = bounds.maxY - bounds.minY;
    // Eğik kenarlar dahil yeterince uzun tüm kenarlara çevre bayı dene.
    const minEdgeLen = sw * 4;
    for (let i = 0; i < rpoly.length; i++) {
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
      const inward = normals.find((n) => _pointInPoly({ x: mid.x + n.x * sd * 0.65, y: mid.y + n.y * sd * 0.65 }, rpoly));
      if (!inward) continue;
      // Kenarın HİÇBİR yerinde koridor yoksa kenarı tümden atla (ucuz ön-eleme).
      const edgeProbe = { x: mid.x + inward.x * (sd + aw * 0.5), y: mid.y + inward.y * (sd + aw * 0.5) };
      const edgeHasAisle = layout.aisles.some((al) =>
        _distancePointToRect(edgeProbe, { x0: al.x0, y0: al.y0, x1: al.x1, y1: al.y1 }) < len / 2 + aw
      );
      if (!edgeHasAisle) continue;

      for (let t = 0; t + sw <= len; t += sw) {
        const p0 = { x: a.x + ux * t, y: a.y + uy * t };
        const p1 = { x: a.x + ux * (t + sw), y: a.y + uy * (t + sw) };
        const p2 = { x: p1.x + inward.x * sd, y: p1.y + inward.y * sd };
        const p3 = { x: p0.x + inward.x * sd, y: p0.y + inward.y * sd };
        // HER BAY için ayrı erişim: iç kenarı bir koridora NEREDEYSE TEMAS etmeli
        // (boşluk ~1 m'den fazlaysa ölü şerit oluşur → bayı ekleme).
        const innerMid = { x: (p2.x + p3.x) / 2, y: (p2.y + p3.y) / 2 };
        const probe = { x: innerMid.x + inward.x * (aw * 0.05), y: innerMid.y + inward.y * (aw * 0.05) };
        const adjacent = layout.aisles.some((al) =>
          _distancePointToRect(probe, { x0: al.x0, y0: al.y0, x1: al.x1, y1: al.y1 }) < aw * 0.15
        );
        if (!adjacent) continue;
        addBayIfClear(bays, layout.aisles, { corners: [p0, p1, p2, p3] }, rpoly, rgates);
      }
    }
    for (const bay of innerBays) {
      addBayIfClear(bays, layout.aisles, bay, rpoly, rgates);
    }

    return { count: bays.length, bays, aisles: layout.aisles };
  }

  function scoreLayout(layout, rgates) {
    if (!layout || !layout.count) return -Infinity;
    const aisleLength = layout.aisles.reduce((sum, a) => sum + Math.abs(a.x1 - a.x0), 0);
    let gatePenalty = 0;
    for (const gate of rgates) {
      let bestDist = Infinity;
      for (const aisle of layout.aisles) {
        bestDist = Math.min(bestDist, _distancePointToRect(gate.point, aisle));
      }
      gatePenalty += bestDist;
    }
    return layout.count * 100000 + aisleLength - gatePenalty * 250;
  }

  // Açı + koridor fazı (startY) + x-fazı taraması. Arama sırasında yalnızca iç
  // ağ skorlanır (hızlı); çevre bayları yalnızca KAZANAN düzene bir kez eklenir.
  let best = null;
  const OX = 3;
  for (let aDeg = 0; aDeg < 180; aDeg += opts.angleStepDeg) {
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
function _largestRect(grid, R, C) {
  const h = new Array(C).fill(0);
  let best = null;
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) h[c] = grid[r * C + c] ? h[c] + 1 : 0;
    const stack = [];
    for (let c = 0; c <= C; c++) {
      const cur = c < C ? h[c] : 0;
      let start = c;
      while (stack.length && stack[stack.length - 1].h > cur) {
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
  let cx = 0, cy = 0;
  for (const p of st) { cx += p.x; cy += p.y; }
  cx /= st.length; cy /= st.length;
  for (const p of st) {
    if (!_pointInPoly({ x: p.x + (cx - p.x) * 0.06, y: p.y + (cy - p.y) * 0.06 }, poly)) return false;
  }
  return _pointInPoly({ x: cx, y: cy }, poly);
}

// Poligonu büyük dikdörtgenlere ayırıp (greedy largest-rectangle) her birini
// kendi yön+fazıyla yerleştirir. İnce şerit / girinti gibi farklı faz isteyen
// bölgeler ana ızgaraya feda edilmeden dolar.
function _decomposeLayout(polygon, mpp, opts) {
  const pxPerM = 1 / mpp;
  const sw = opts.stallWidthM * pxPerM;
  const sd = opts.stallDepthM * pxPerM;
  const aw = opts.aisleWidthM * pxPerM;
  const minBand = sd + aw;

  const b = _polyBounds(polygon);
  const cell = Math.max(4, sd * 0.35);
  const C = Math.ceil((b.maxX - b.minX) / cell);
  const R = Math.ceil((b.maxY - b.minY) / cell);
  if (C < 2 || R < 2 || C * R > 300000) return null;

  const grid = new Uint8Array(R * C);
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      const p = { x: b.minX + (c + 0.5) * cell, y: b.minY + (r + 0.5) * cell };
      grid[r * C + c] = _pointInPoly(p, polygon) ? 1 : 0;
    }
  }

  const rects = [];
  for (let it = 0; it < 12 && rects.length < 6; it++) {
    const rc = _largestRect(grid, R, C);
    if (!rc) break;
    for (let r = rc.r0; r < rc.r1; r++) for (let c = rc.c0; c < rc.c1; c++) grid[r * C + c] = 0;
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

  const stalls = [], aisles = [], boxes = [];
  const ov = (q) => {
    const bb = _bboxOfPoints(q);
    return boxes.some((e) => bb.x < e.x + e.w && e.x < bb.x + bb.w && bb.y < e.y + e.h && e.y < bb.y + bb.h);
  };
  for (const rect of rects) {
    const r = _layoutSingle(rect, mpp, opts);
    if (!r) continue;
    for (const st of r.stalls) {
      if (_bayInside(st, polygon) && !ov(st)) { stalls.push(st); boxes.push(_bboxOfPoints(st)); }
    }
    for (const al of r.aisles) {
      if (!ov(al)) { aisles.push(al); boxes.push(_bboxOfPoints(al)); }
    }
  }
  return { count: stalls.length, stalls, aisles };
}

// En verimli park yerleşimini hesaplar. Tek-yön/faz çözümü (A) ile bölgesel
// ayrıştırma (B) hesaplanır; daha çok bay üreten seçilir. Böylece döndürülmüş
// konveks parseller tek-yönde, ince şerit/girintili parseller B'de kazanır.
//   Döndürür: { count, angleDeg, stalls:[[{x,y}*4]], aisles:[[{x,y}*4]], areaM2, opts }
function computeBestLayout(polygon, mpp, opts) {
  const A = _layoutSingle(polygon, mpp, opts);
  if (!A) return null;
  opts = A.opts;
  let B = null;
  try { B = _decomposeLayout(polygon, mpp, opts); } catch (e) { B = null; }
  const useB = B && B.count > A.count;
  let stalls = useB ? B.stalls : A.stalls;
  let aisles = useB ? B.aisles : A.aisles;

  // İsteğe bağlı: kalan büyük boş alanları da kendi yön/fazıyla ek olarak doldur.
  if (opts.fillEmpty) {
    const filled = _fillEmpty(polygon, mpp, opts, { stalls, aisles });
    stalls = filled.stalls;
    aisles = filled.aisles;
  }
  return { count: stalls.length, angleDeg: A.angleDeg, stalls, aisles, areaM2: A.areaM2, opts };
}

// Mevcut yerleşimin kaplamadığı büyük boş dikdörtgenleri bulup her birini
// kendi yön/fazıyla doldurur ve sonuca EKLER (değiştirmez). isteğe bağlı.
function _fillEmpty(polygon, mpp, opts, layout) {
  const pxPerM = 1 / mpp;
  const sd = opts.stallDepthM * pxPerM;
  const aw = opts.aisleWidthM * pxPerM;
  const sw = opts.stallWidthM * pxPerM;
  const minBand = sd + aw;

  const b = _polyBounds(polygon);
  const cell = Math.max(4, sd * 0.4);
  const C = Math.ceil((b.maxX - b.minX) / cell);
  const R = Math.ceil((b.maxY - b.minY) / cell);
  if (C < 2 || R < 2 || C * R > 300000) return layout;

  const grid = new Uint8Array(R * C);
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
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
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) grid[r * C + c] = 0;
  };
  for (const s of layout.stalls) markCov(s);
  for (const a of layout.aisles) markCov(a);

  const stalls = layout.stalls.slice();
  const aisles = layout.aisles.slice();
  const boxes = stalls.concat(aisles).map(_bboxOfPoints);
  const ov = (q) => {
    const bb = _bboxOfPoints(q);
    return boxes.some((e) => bb.x < e.x + e.w && e.x < bb.x + bb.w && bb.y < e.y + e.h && e.y < bb.y + bb.h);
  };

  for (let it = 0; it < 8; it++) {
    const rc = _largestRect(grid, R, C);
    if (!rc) break;
    for (let r = rc.r0; r < rc.r1; r++) for (let c = rc.c0; c < rc.c1; c++) grid[r * C + c] = 0;
    const rx0 = b.minX + rc.c0 * cell, rx1 = b.minX + rc.c1 * cell;
    const ry0 = b.minY + rc.r0 * cell, ry1 = b.minY + rc.r1 * cell;
    if (Math.min(rx1 - rx0, ry1 - ry0) < minBand * 0.95) continue;
    const ex = cell * 1.5;
    const x0 = Math.max(b.minX, rx0 - ex), x1 = Math.min(b.maxX, rx1 + ex);
    const y0 = Math.max(b.minY, ry0 - ex), y1 = Math.min(b.maxY, ry1 + ex);
    const sub = _layoutSingle([{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], mpp, opts);
    if (!sub) continue;
    for (const st of sub.stalls) {
      if (_bayInside(st, polygon) && !ov(st)) { stalls.push(st); boxes.push(_bboxOfPoints(st)); }
    }
    for (const al of sub.aisles) {
      if (!ov(al)) { aisles.push(al); boxes.push(_bboxOfPoints(al)); }
    }
  }
  return { count: stalls.length, stalls, aisles };
}

// Kullanıcı yolları elle taşıdıktan sonra: koridorları SABİT tutup
// park yerlerini onların uzun kenarları boyunca yeniden dizer.
//   polygon, aisleQuads, gates: hepsi ekran pikseli (4 köşeli quad'lar).
function fillBaysForAisles(polygon, mpp, opts, aisleQuads) {
  opts = Object.assign(
    { stallWidthM: 2.5, stallDepthM: 5.0, aisleWidthM: 6.0 },
    opts || {}
  );
  if (!polygon || polygon.length < 3 || !mpp || mpp <= 0) return null;
  if (!aisleQuads || !aisleQuads.length) return null;

  const pxPerM = 1 / mpp;
  const sw = opts.stallWidthM * pxPerM;
  const sd = opts.stallDepthM * pxPerM;
  const gates = Array.isArray(opts.gates) ? opts.gates.filter((g) => g && g.point) : [];
  const gateClearance = Math.max(opts.aisleWidthM * pxPerM * 1.35, sd * 1.1);

  const D = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const N = (v) => { const l = Math.hypot(v.x, v.y) || 1; return { x: v.x / l, y: v.y / l }; };
  const aisleRects = aisleQuads.map((q) => _bboxOfPoints(q));
  const bays = [];

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
        const p0 = { x: e.a.x + u.x * t, y: e.a.y + u.y * t };
        const p1 = { x: e.a.x + u.x * (t + sw), y: e.a.y + u.y * (t + sw) };
        const p2 = { x: p1.x + n.x * sd, y: p1.y + n.y * sd };
        const p3 = { x: p0.x + n.x * sd, y: p0.y + n.y * sd };
        const corners = [p0, p1, p2, p3];
        const cc = { x: (p0.x + p1.x + p2.x + p3.x) / 4, y: (p0.y + p1.y + p2.y + p3.y) / 4 };
        if (!_pointInPoly(p2, polygon) || !_pointInPoly(p3, polygon) || !_pointInPoly(cc, polygon)) continue;

        const bb = _bboxOfPoints(corners);
        const rect = { x0: bb.x, y0: bb.y, x1: bb.x + bb.w, y1: bb.y + bb.h };
        if (gates.some((g) => _distancePointToRect(g.point, rect) < gateClearance)) continue;
        if (aisleRects.some((ar) => _rectsOverlap(bb, ar))) continue;
        if (bays.some((ex) => _rectsOverlap(bb, _bboxOfPoints(ex)))) continue;
        bays.push(corners);
      }
    }
  }

  const areaM2 = _polyAreaPx(polygon) * mpp * mpp;
  return { count: bays.length, stalls: bays, aisles: aisleQuads, areaM2, opts };
}
