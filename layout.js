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

// En verimli park yerleşimini hesaplar.
//   polygon: [{x,y}] (CSS piksel),  mpp: metre/piksel
//   opts: { stallWidthM, stallDepthM, aisleWidthM, angleStepDeg, gates }
// Döndürür: { count, angleDeg, stalls:[[{x,y}*4]], aisles:[[{x,y}*4]], areaM2, opts }
function computeBestLayout(polygon, mpp, opts) {
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
    const rect = { x0: bay.x, y0: bay.y, x1: bay.x + sw, y1: bay.y + sd };
    return rgates.some((gate) => _distancePointToRect(gate.point, rect) < gateClearance);
  }

  function generateAisle(rpoly, aisleY, offX, rgates) {
    const { minX, maxX } = _polyBounds(rpoly);
    const cells = [];

    for (let x = minX - offX; x + sw <= maxX; x += sw) {
      const aisleOk = _rectInsidePoly(x, aisleY, x + sw, aisleY + aw, rpoly);
      const bays = [];

      if (aisleOk) {
        const lowerY = aisleY - sd;
        const upperY = aisleY + aw;
        const lowerBay = { x, y: lowerY };
        const upperBay = { x, y: upperY };
        if (_rectInsidePoly(x, lowerY, x + sw, aisleY, rpoly) && !bayBlockedByGate(lowerBay, rgates)) {
          bays.push(lowerBay);
        }
        if (_rectInsidePoly(x, upperY, x + sw, upperY + sd, rpoly) && !bayBlockedByGate(upperBay, rgates)) {
          bays.push(upperBay);
        }
      }
      cells.push({ x, aisleOk, bays });
    }

    let bestRun = null;
    let run = null;

    function closeRun() {
      if (!run || !run.bays.length) {
        run = null;
        return;
      }
      run.x1 = run.lastX + sw;
      const score = run.bays.length * 100000 + (run.x1 - run.x0);
      if (!bestRun || score > bestRun.score) bestRun = Object.assign({ score }, run);
      run = null;
    }

    for (const cell of cells) {
      if (!cell.aisleOk) {
        closeRun();
        continue;
      }
      if (!run) run = { x0: cell.x, lastX: cell.x, bays: [] };
      run.lastX = cell.x;
      for (const bay of cell.bays) run.bays.push(bay);
    }
    closeRun();

    if (!bestRun) return { count: 0, bays: [], aisles: [] };

    const aisles = [{ x0: bestRun.x0, y0: aisleY, x1: bestRun.x1, y1: aisleY + aw }];
    return { count: bestRun.bays.length, bays: bestRun.bays, aisles };
  }

  function rangesOverlap(a0, a1, b0, b1) {
    return a0 < b1 && b0 < a1;
  }

  function candidateConnectorXs(rpoly, rgates) {
    const { minX, maxX } = _polyBounds(rpoly);
    const span = maxX - minX;
    if (span < aw) return [];

    const values = new Set();
    const add = (x) => {
      if (x >= minX && x + aw <= maxX) values.add(Math.round(x * 1000) / 1000);
    };

    add(minX);
    add(maxX - aw);
    add((minX + maxX - aw) / 2);
    for (const gate of rgates) {
      add(gate.point.x - aw / 2);
      add(gate.point.x);
      add(gate.point.x - aw);
    }

    const steps = 10;
    for (let i = 0; i <= steps; i++) add(minX + ((span - aw) * i) / steps);
    return Array.from(values);
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

  // Büyük alanlarda birden fazla paralel koridor üretir ve bunları dik bir geçişle bağlar.
  // Dar alanlarda otomatik olarak tek koridorlu yerleşime düşer.
  function generateStack(rpoly, startY, offX, connectorX, rgates) {
    const { minY, maxY } = _polyBounds(rpoly);
    const moduleDepth = aw + (backToBack ? 2 * sd : sd);
    const runs = [];

    for (let aisleY = startY; aisleY + aw <= maxY; aisleY += moduleDepth) {
      const run = generateAisle(rpoly, aisleY, offX, rgates);
      if (run.count) runs.push(run);
    }

    if (!runs.length) return { count: 0, bays: [], aisles: [] };
    if (runs.length === 1) return runs[0];

    const y0 = Math.min(...runs.map((r) => r.aisles[0].y0));
    const y1 = Math.max(...runs.map((r) => r.aisles[0].y1));
    const touchesAll = runs.every((r) =>
      rangesOverlap(connectorX, connectorX + aw, r.aisles[0].x0, r.aisles[0].x1)
    );
    if (!touchesAll || !_rectInsidePoly(connectorX, y0, connectorX + aw, y1, rpoly)) {
      return { count: 0, bays: [], aisles: [] };
    }

    const bayMap = new Map();
    const aisles = [];
    for (const run of runs) {
      aisles.push(run.aisles[0]);
      for (const bay of run.bays) {
        if (rangesOverlap(bay.x, bay.x + sw, connectorX, connectorX + aw)) continue;
        const key = `${Math.round(bay.x * 1000)}:${Math.round(bay.y * 1000)}`;
        if (!bayMap.has(key)) bayMap.set(key, bay);
      }
    }
    const bays = Array.from(bayMap.values());
    aisles.push({ x0: connectorX, y0, x1: connectorX + aw, y1 });
    return { count: bays.length, bays, aisles };
  }

  function rotatedLayout(layout, ang) {
    const stalls = layout.bays.map((b) => {
      const cs = _rectCorners(b.x, b.y, b.x + sw, b.y + sd);
      return cs.map((p) => _rotate(p, ang, c));
    });
    const aisles = layout.aisles.map((a) => {
      const cs = _rectCorners(a.x0, a.y0, a.x1, a.y1);
      return cs.map((p) => _rotate(p, ang, c));
    });
    return { stalls, aisles };
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

  // Açı + koridor fazı + geçiş koridoru taraması.
  // Kapasite kadar, bütün park ceplerinin bağlı bir sürüş ağına erişilmesi de şarttır.
  let best = null;
  const OX = 4;
  for (let aDeg = 0; aDeg < 180; aDeg += opts.angleStepDeg) {
    const ang = (aDeg * Math.PI) / 180;
    const rpoly = polygon.map((p) => _rotate(p, -ang, c));
    const rgates = gates.map((g) => ({ type: g.type, point: _rotate(g.point, -ang, c) }));
    for (const startY of candidateStackStarts(rpoly, rgates)) {
      for (let ix = 0; ix < OX; ix++) {
        const offX = (sw * ix) / OX;
        for (const connectorX of candidateConnectorXs(rpoly, rgates)) {
          const r = generateStack(rpoly, startY, offX, connectorX, rgates);
          const score = scoreLayout(r, rgates);
          if (!best || score > best.score) {
            best = { score, count: r.count, aDeg, ang, layout: r };
          }
        }
      }
    }
  }

  if (!best || !best.count) return null;
  const { stalls, aisles } = rotatedLayout(best.layout, best.ang);

  const areaM2 = _polyAreaPx(polygon) * mpp * mpp;
  return { count: best.count, angleDeg: best.aDeg, stalls, aisles, areaM2, opts };
}
