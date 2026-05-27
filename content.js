// content.js — Google Maps üzerine coğrafi sabitlenmiş overlay + panel.
(function () {
  "use strict";
  if (window.__otoparkPlannerLoaded) return;
  window.__otoparkPlannerLoaded = true;
  console.log("[Otopark] içerik betiği yüklendi ✓");

  const Z_CANVAS = 2147483646;
  const TILE = 256;

  // ---- Durum ----
  let mode = "idle";        // idle | draw | gate-entry | gate-exit | road | road-delete
  let polygonLL = [];       // [{lat,lng}] çizilen alan köşeleri
  let closed = false;
  let stallsLL = [];        // [[{lat,lng}*4], ...] hesaplanan park yerleri
  let stallTypes = [];      // standard | accessible | ev | landscape
  let aislesLL = [];        // [[{lat,lng}*4], ...] sürüş koridorları
  let gatesLL = [];         // [{type:"entry"|"exit", ll}]
  let result = null;        // { count, angleDeg, areaM2 }
  let cursor = null;        // imleç (ekran px)
  let cam = null;           // { lat, lng, zoom }
  let roadDrag = null;      // { type, index, corner, edge, start:{x,y}, original:[{lat,lng}*4] }
  // canlı kaydırma için
  let dragging = false, dragStart = null, dragDelta = { x: 0, y: 0 };
  let lastPointer = { x: 0, y: 0 };

  // ---- Web Mercator projeksiyonu ----
  function getCamera() {
    const m = location.href.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?)z/);
    if (!m) return null;
    return { lat: parseFloat(m[1]), lng: parseFloat(m[2]), zoom: parseFloat(m[3]) };
  }
  function project(lat, lng, scale) {
    const siny = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999);
    return {
      x: ((lng + 180) / 360) * scale,
      y: (0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI)) * scale,
    };
  }
  function ll2px(ll, c) {
    const scale = TILE * Math.pow(2, c.zoom);
    const w = project(ll.lat, ll.lng, scale);
    const o = project(c.lat, c.lng, scale);
    return { x: w.x - o.x + innerWidth / 2, y: w.y - o.y + innerHeight / 2 };
  }
  function px2ll(px, py, c) {
    const scale = TILE * Math.pow(2, c.zoom);
    const o = project(c.lat, c.lng, scale);
    const wx = px - innerWidth / 2 + o.x;
    const wy = py - innerHeight / 2 + o.y;
    const lng = (wx / scale) * 360 - 180;
    const latRad = 2 * Math.atan(Math.exp(Math.PI * (1 - (2 * wy) / scale))) - Math.PI / 2;
    return { lat: (latRad * 180) / Math.PI, lng };
  }
  function mppFromCam(c) {
    return (156543.03392 * Math.cos((c.lat * Math.PI) / 180)) / Math.pow(2, c.zoom);
  }

  // ---- Canvas ----
  const canvas = document.createElement("canvas");
  canvas.id = "opl-canvas";
  Object.assign(canvas.style, {
    position: "fixed", left: "0", top: "0",
    width: "100vw", height: "100vh",
    zIndex: String(Z_CANVAS), pointerEvents: "none",
  });
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  let dpr = window.devicePixelRatio || 1;

  function resize() {
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }
  window.addEventListener("resize", resize);

  function setInteractive(on) {
    canvas.style.pointerEvents = on ? "auto" : "none";
    canvas.style.cursor = on ? (mode === "road" ? "grab" : mode === "road-delete" ? "not-allowed" : "crosshair") : "default";
  }

  // ---- Panel ----
  const panel = document.createElement("div");
  panel.id = "opl-panel";
  panel.innerHTML = `
    <h1>🅿️ Otopark Yerleşim (Test)</h1>
    <div class="opl-scale" id="opl-scale">Ölçek hesaplanıyor…</div>
    <div class="opl-row">
      <button id="opl-draw">Alan Çiz</button>
      <button id="opl-finish" class="opl-secondary">Bitir</button>
    </div>
	    <div class="opl-fields">
	      <label>Park genişlik (m)<input id="opl-sw" type="number" step="0.1" value="2.5"></label>
	      <label>Park derinlik (m)<input id="opl-sd" type="number" step="0.1" value="5.0"></label>
	      <label>Koridor (m)<input id="opl-aw" type="number" step="0.1" value="6.0"></label>
	      <label>Açı adımı (°)<input id="opl-as" type="number" step="5" value="10"></label>
	    </div>
	    <label class="opl-check"><input id="opl-btb" type="checkbox" checked> Sırt sırta çift park</label>
	    <label class="opl-check"><input id="opl-singlelane" type="checkbox"> Tek şerit yol (3.5 m)</label>
			    <div class="opl-row">
		      <button id="opl-compute">Yerleşimi Hesapla</button>
		      <button id="opl-clear" class="opl-danger">Temizle</button>
	    </div>
	    <div class="opl-row">
	      <button id="opl-entry" class="opl-secondary">Giriş Kapısı</button>
	      <button id="opl-exit" class="opl-secondary">Çıkış Kapısı</button>
		    </div>
		    <div class="opl-row">
		      <button id="opl-roadedit" class="opl-secondary">Yol Taşı</button>
		      <button id="opl-roaddelete" class="opl-danger">Yol Sil</button>
		    </div>
	    <div class="opl-result" id="opl-result" style="display:none"></div>
    <div class="opl-status" id="opl-status">Önce "Alan Çiz" ile araziyi işaretle.</div>
  `;
  document.body.appendChild(panel);
  console.log("[Otopark] panel eklendi ✓");

  const $ = (id) => panel.querySelector(id);
  const statusEl = $("#opl-status");
  const resultEl = $("#opl-result");
  const scaleEl = $("#opl-scale");
  const setStatus = (t) => (statusEl.textContent = t);

  function updateScaleReadout() {
    if (!cam) {
      scaleEl.textContent = "⚠ Konum okunamadı. Üstten (2B) görünüme geçin.";
      return;
    }
    scaleEl.textContent = `Ölçek: ${mppFromCam(cam).toFixed(3)} m/piksel · zoom ${cam.zoom}`;
  }

  // ---- Toast ----
  const toastEl = document.createElement("div");
  toastEl.id = "opl-toast";
  document.body.appendChild(toastEl);
  let toastT;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("opl-show");
    clearTimeout(toastT);
    toastT = setTimeout(() => toastEl.classList.remove("opl-show"), 2600);
  }

  // ---- Çizim ----
  function tracePath(pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  }

  function pointInScreenPoly(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      const hit =
        a.y > pt.y !== b.y > pt.y &&
        pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x;
      if (hit) inside = !inside;
    }
    return inside;
  }

  function nearestBoundaryPoint(pt, poly) {
    let best = null;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2)) : 0;
      const x = a.x + dx * t, y = a.y + dy * t;
      const dist = Math.hypot(pt.x - x, pt.y - y);
      if (!best || dist < best.dist) best = { x, y, dist };
    }
    return best;
  }

  function gateLabel(type) {
    return type === "entry" ? "Giriş" : "Çıkış";
  }

  function centroid(pts) {
    let x = 0, y = 0;
    for (const p of pts) { x += p.x; y += p.y; }
    return { x: x / pts.length, y: y / pts.length };
  }

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function isNearStart(pt) {
    if (!cam || polygonLL.length < 3) return false;
    const start = ll2px(polygonLL[0], cam);
    return dist(pt, start) <= 14;
  }

  function aisleWidthM(a) {
    if (!cam) return 0;
    const wPx = (dist(a[0], a[3]) + dist(a[1], a[2])) / 2;
    return wPx * mppFromCam(cam);
  }

  function aisleLengthM(a) {
    if (!cam) return 0;
    const lPx = (dist(a[0], a[1]) + dist(a[3], a[2])) / 2;
    return lPx * mppFromCam(cam);
  }

  function classifyStalls(stallsPx) {
    const types = stallsPx.map(() => "standard");
    const centers = stallsPx.map((st, index) => ({ index, c: centroid(st) }));
    const ordered = centers.slice().sort((a, b) => a.c.y - b.c.y || a.c.x - b.c.x);

    for (let i = 8; i < ordered.length; i += 18) types[ordered[i].index] = "landscape";
    for (let i = 14; i < ordered.length; i += 28) types[ordered[i].index] = "landscape";

    const gatePts = gatesLL.map((g) => ll2px(g.ll, cam));
    const accessibleOrder = centers.slice().sort((a, b) => {
      const da = gatePts.length ? Math.min(...gatePts.map((p) => Math.hypot(a.c.x - p.x, a.c.y - p.y))) : a.c.y;
      const db = gatePts.length ? Math.min(...gatePts.map((p) => Math.hypot(b.c.x - p.x, b.c.y - p.y))) : b.c.y;
      return da - db;
    });
    for (const item of accessibleOrder.slice(0, Math.min(6, Math.ceil(stallsPx.length * 0.06)))) {
      if (types[item.index] !== "landscape") types[item.index] = "accessible";
    }

    const evOrder = centers.slice().sort((a, b) => b.c.x - a.c.x || a.c.y - b.c.y);
    let evCount = 0;
    const evTarget = Math.min(14, Math.max(4, Math.ceil(stallsPx.length * 0.08)));
    for (const item of evOrder) {
      if (evCount >= evTarget) break;
      if (types[item.index] === "standard") {
        types[item.index] = "ev";
        evCount++;
      }
    }
    return types;
  }

  function parkingCount() {
    return stallTypes.filter((t) => t !== "landscape").length || stallsLL.length;
  }

  function refreshResultCount() {
    if (!result) return;
    const count = parkingCount();
    result.count = count;
    const perCar = count ? (result.areaM2 / count).toFixed(1) : "—";
    resultEl.innerHTML =
      `<b>${count}</b> erişilebilir araç kapasitesi<br>` +
      `Yön: ${result.angleDeg}° · Alan: ${result.areaM2.toFixed(0)} m²<br>` +
      `Verim: 1 araç / ${perCar} m²`;
  }

  // Sürüş koridorunu (gri şerit + ölçü etiketi + tutamaçlar) çizer.
  function drawAisle(a, index) {
    ctx.beginPath();
    ctx.moveTo(a[0].x, a[0].y);
    for (let i = 1; i < a.length; i++) ctx.lineTo(a[i].x, a[i].y);
    ctx.closePath();
    ctx.fillStyle = "rgba(119,128,136,0.76)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.45)";
    ctx.lineWidth = 1;
    ctx.stroke();
    // orta çizgi (kesikli): kısa kenarların orta noktaları arası
    const m1 = { x: (a[0].x + a[3].x) / 2, y: (a[0].y + a[3].y) / 2 };
    const m2 = { x: (a[1].x + a[2].x) / 2, y: (a[1].y + a[2].y) / 2 };
    ctx.beginPath();
    ctx.moveTo(m1.x, m1.y);
    ctx.lineTo(m2.x, m2.y);
    ctx.strokeStyle = "rgba(255,235,120,0.7)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([10, 8]);
    ctx.stroke();
    ctx.setLineDash([]);

    const dx = m2.x - m1.x, dy = m2.y - m1.y;
    const len = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    const arrows = Math.max(1, Math.floor(len / 120));
    const ux = len ? dx / len : 0, uy = len ? dy / len : 0;
    ctx.fillStyle = "rgba(255,235,120,0.78)";
    function arrowHead(x, y, rot) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.beginPath();
      ctx.moveTo(7, 0);
      ctx.lineTo(-5, -4);
      ctx.lineTo(-5, 4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    for (let i = 1; i <= arrows; i++) {
      const t = i / (arrows + 1);
      const x = m1.x + dx * t, y = m1.y + dy * t;
      arrowHead(x + ux * 8, y + uy * 8, angle);
      arrowHead(x - ux * 8, y - uy * 8, angle + Math.PI);
    }

    const label = `${aisleWidthM(a).toFixed(1)} m`;
    const lc = centroid(a);
    ctx.save();
    ctx.translate(lc.x, lc.y);
    ctx.rotate(angle);
    ctx.font = "700 11px -apple-system, Segoe UI, Roboto, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const tw = ctx.measureText(label).width + 12;
    ctx.fillStyle = "rgba(20,22,28,0.78)";
    ctx.beginPath();
    ctx.roundRect(-tw / 2, -10, tw, 20, 5);
    ctx.fill();
    ctx.fillStyle = "#fef3c7";
    ctx.fillText(label, 0, 0);
    ctx.restore();

    if (mode === "road") {
      ctx.fillStyle = "rgba(250,204,21,0.95)";
      ctx.strokeStyle = "rgba(20,22,28,0.95)";
      ctx.lineWidth = 1.5;
      for (const p of a) {
        ctx.beginPath();
        ctx.rect(p.x - 5, p.y - 5, 10, 10);
        ctx.fill();
        ctx.stroke();
      }
      for (let i = 0; i < a.length; i++) {
        const p = a[i], q = a[(i + 1) % a.length];
        ctx.beginPath();
        ctx.arc((p.x + q.x) / 2, (p.y + q.y) / 2, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      if (index != null) {
        const lLabel = `${aisleLengthM(a).toFixed(1)} m`;
        ctx.font = "700 10px -apple-system, Segoe UI, Roboto, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(20,22,28,0.72)";
        ctx.fillText(lLabel, lc.x, lc.y + 18);
      }
    }
  }

  // Tek bir park cebini plan stiliyle çizer.
  function drawBay(st, type) {
    let cx = 0, cy = 0;
    for (const p of st) { cx += p.x; cy += p.y; }
    cx /= 4; cy /= 4;
    const k = 0.86; // cepler arası boşluk için içe daraltma
    const pts = st.map((p) => ({ x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k }));
    ctx.beginPath();
    pts.forEach((p, i) => {
      i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
    });
    ctx.closePath();
    ctx.fillStyle = {
      accessible: "rgba(37,99,235,0.78)",
      ev: "rgba(34,197,94,0.7)",
      landscape: "rgba(101,163,13,0.82)",
      standard: "rgba(120,128,136,0.18)",
    }[type || "standard"];
    ctx.fill();
    ctx.strokeStyle = type === "landscape" ? "rgba(236,252,203,0.9)" : "rgba(255,255,255,0.92)";
    ctx.lineWidth = type === "landscape" ? 1 : 1.35;
    ctx.stroke();

    if (type === "landscape") {
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(4, Math.min(8, Math.hypot(st[1].x - st[0].x, st[1].y - st[0].y) * 0.22)), 0, Math.PI * 2);
      ctx.fillStyle = "#15803d";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.75)";
      ctx.lineWidth = 1;
      ctx.stroke();
    } else if (type === "accessible") {
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.font = "700 9px -apple-system, Segoe UI, Roboto, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("P", cx, cy);
    }
  }

  function drawGate(gate) {
    const p = ll2px(gate.ll, cam);
    const color = gate.type === "entry" ? "#22c55e" : "#ef4444";
    ctx.save();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "#fff";
    ctx.stroke();

    ctx.font = "700 12px -apple-system, Segoe UI, Roboto, sans-serif";
    ctx.textBaseline = "middle";
    const text = gateLabel(gate.type);
    const w = ctx.measureText(text).width + 14;
    ctx.fillStyle = "rgba(20,22,28,0.9)";
    ctx.beginPath();
    ctx.roundRect(p.x + 12, p.y - 11, w, 22, 6);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillText(text, p.x + 19, p.y);
    ctx.restore();
  }

  function redraw() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    if (!cam) return;

    // Tamamlanmış alan: asfalt zemin + park cepleri (alanla kırpılmış)
    if (closed && polygonLL.length >= 3) {
      const poly = polygonLL.map((ll) => ll2px(ll, cam));
      ctx.save();
      tracePath(poly);
      ctx.closePath();
      ctx.clip();
	      // Referans planlardaki gibi daha opak asfalt/site zemini.
	      ctx.fillStyle = "rgba(111,121,130,0.82)";
	      ctx.fillRect(0, 0, innerWidth, innerHeight);
	      // önce koridorlar (altta), sonra baylar (üstte)
		      for (let i = 0; i < aislesLL.length; i++) {
		        drawAisle(aislesLL[i].map((ll) => ll2px(ll, cam)), i);
		      }
	      for (let i = 0; i < stallsLL.length; i++) {
	        drawBay(stallsLL[i].map((ll) => ll2px(ll, cam)), stallTypes[i] || "standard");
	      }
	      ctx.restore();

	      // alan kenarı
	      tracePath(poly);
	      ctx.closePath();
	      ctx.strokeStyle = "#facc15";
	      ctx.lineWidth = 2.5;
	      ctx.stroke();
	      for (const gate of gatesLL) drawGate(gate);
	    }

	    // Çizim halindeki alan
	    if (!closed && polygonLL.length) {
	      const pts = polygonLL.map((ll) => ll2px(ll, cam));
	      const canClose = cursor && mode === "draw" && isNearStart(cursor);
	      ctx.beginPath();
	      ctx.moveTo(pts[0].x, pts[0].y);
	      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
	      if (cursor && mode === "draw") {
	        const end = canClose ? pts[0] : cursor;
	        ctx.lineTo(end.x, end.y);
	      }
	      ctx.strokeStyle = "#ffd400";
	      ctx.lineWidth = 2;
	      ctx.setLineDash([6, 4]);
	      ctx.stroke();
	      ctx.setLineDash([]);
	      ctx.fillStyle = "#ffd400";
	      for (const p of pts) { ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, 7); ctx.fill(); }
	      if (pts.length >= 3) {
	        ctx.beginPath();
	        ctx.arc(pts[0].x, pts[0].y, canClose ? 9 : 7, 0, Math.PI * 2);
	        ctx.fillStyle = canClose ? "rgba(34,197,94,0.95)" : "rgba(250,204,21,0.9)";
	        ctx.fill();
	        ctx.lineWidth = 2;
	        ctx.strokeStyle = "#fff";
	        ctx.stroke();
	      }
	    }
  }

  // ---- Aksiyonlar ----
  function startDraw() {
    if (!cam) { toast("Konum okunamadı; üstten 2B görünüme geç."); return; }
    polygonLL = []; closed = false; stallsLL = []; stallTypes = []; aislesLL = []; gatesLL = []; result = null;
    dragDelta = { x: 0, y: 0 }; canvas.style.transform = "";
    resultEl.style.display = "none";
    mode = "draw";
    setInteractive(true);
    setStatus("Köşeleri tıkla. Başlangıç noktasına dönünce otomatik kapanır.");
    redraw();
  }
  function finishPolygon() {
    if (polygonLL.length < 3) { toast("En az 3 köşe gerekli."); return; }
    closed = true;
    mode = "idle";
    setInteractive(false);
    setStatus("Alan hazır. 'Yerleşimi Hesapla'ya bas.");
    redraw();
  }
  function clearAll() {
    polygonLL = []; closed = false; stallsLL = []; stallTypes = []; aislesLL = []; gatesLL = []; result = null;
    mode = "idle";
    setInteractive(false);
    resultEl.style.display = "none";
    setStatus("Temizlendi. 'Alan Çiz' ile yeniden başla.");
    redraw();
  }
  function startGate(type) {
    if (!closed || polygonLL.length < 3) { toast("Önce alanı bitir."); return; }
    mode = type === "entry" ? "gate-entry" : "gate-exit";
    roadDrag = null;
    setInteractive(true);
    setStatus(`${gateLabel(type)} için alan sınırına tıkla; nokta en yakın kenara oturur.`);
    redraw();
  }
  function startRoadEdit() {
    if (!aislesLL.length) { toast("Önce yerleşimi hesapla."); return; }
    mode = "road";
    roadDrag = null;
    setInteractive(true);
    setStatus("Yolu taşı veya sarı köşelerden tutup boyunu/genişliğini ayarla. Escape ile çık.");
    redraw();
  }
  function startRoadDelete() {
    if (!aislesLL.length) { toast("Önce yerleşimi hesapla."); return; }
    mode = "road-delete";
    roadDrag = null;
    setInteractive(true);
    setStatus("Silmek istediğin gri yola tıkla. Escape ile çık.");
    redraw();
  }
  function placeGate(type, pt) {
    if (!cam || !closed || polygonLL.length < 3) return;
    const poly = polygonLL.map((ll) => ll2px(ll, cam));
    const snapped = nearestBoundaryPoint(pt, poly);
    if (!snapped || snapped.dist > 36) {
      toast("Kapıyı sarı alan sınırına daha yakın seç.");
      return;
    }
    const ll = px2ll(snapped.x, snapped.y, cam);
    gatesLL = gatesLL.filter((g) => g.type !== type).concat({ type, ll });
    setStatus(`${gateLabel(type)} kapısı seçildi. Yerleşimi tekrar hesaplayabilirsin.`);
    mode = "idle";
    setInteractive(false);
    redraw();
  }
	  function compute() {
	    if (!closed || polygonLL.length < 3) { toast("Önce bir alan çiz."); return; }
	    if (!cam) { toast("Konum/ölçek yok."); return; }
	    const mpp = mppFromCam(cam);
	    const singleLane = $("#opl-singlelane").checked;
	    const aisleWidthM = singleLane ? 3.5 : (parseFloat($("#opl-aw").value) || 6.0);
	    const opts = {
	      stallWidthM: parseFloat($("#opl-sw").value) || 2.5,
	      stallDepthM: parseFloat($("#opl-sd").value) || 5.0,
	      aisleWidthM,
	      angleStepDeg: Math.max(5, parseFloat($("#opl-as").value) || 15),
	      gates: gatesLL.map((g) => ({ type: g.type, point: ll2px(g.ll, cam) })),
	      backToBack: $("#opl-btb").checked,
	    };
    const polyPx = polygonLL.map((ll) => ll2px(ll, cam));
    const t0 = performance.now();
    const r = computeBestLayout(polyPx, mpp, opts);
    const ms = (performance.now() - t0).toFixed(0);
    if (!r) { toast("Hesaplanamadı."); return; }
    // Park yerlerini coğrafi koordinata çevirerek sakla (sabitleme için)
    stallsLL = r.stalls.map((st) => st.map((p) => px2ll(p.x, p.y, cam)));
    stallTypes = classifyStalls(r.stalls);
    aislesLL = r.aisles.map((a) => a.map((p) => px2ll(p.x, p.y, cam)));
    const effectiveCount = parkingCount();
    result = { count: effectiveCount, angleDeg: r.angleDeg, areaM2: r.areaM2 };
    redraw();
    const perCar = effectiveCount ? (r.areaM2 / effectiveCount).toFixed(1) : "—";
    resultEl.style.display = "block";
	    resultEl.innerHTML =
	      `<b>${effectiveCount}</b> erişilebilir araç kapasitesi<br>` +
	      `Yön: ${r.angleDeg}° · Yol: ${aisleWidthM.toFixed(1)} m · Alan: ${r.areaM2.toFixed(0)} m²<br>` +
	      `Verim: 1 araç / ${perCar} m² · ${ms} ms`;
    setStatus("Hesaplandı. Park cepleri bağlı sürüş koridorlarına açılır.");
  }

  // ---- Canvas olayları (çizim) ----
  function hitAisle(pt) {
    for (let i = aislesLL.length - 1; i >= 0; i--) {
      const poly = aislesLL[i].map((ll) => ll2px(ll, cam));
      if (pointInScreenPoly(pt, poly)) return i;
    }
    return -1;
  }

  function hitAisleCorner(pt) {
    for (let i = aislesLL.length - 1; i >= 0; i--) {
      const poly = aislesLL[i].map((ll) => ll2px(ll, cam));
      for (let corner = 0; corner < poly.length; corner++) {
        if (dist(pt, poly[corner]) <= 12) return { index: i, corner };
      }
    }
    return null;
  }

  function hitAisleEdge(pt) {
    for (let i = aislesLL.length - 1; i >= 0; i--) {
      const poly = aislesLL[i].map((ll) => ll2px(ll, cam));
      for (let edge = 0; edge < poly.length; edge++) {
        const p = poly[edge], q = poly[(edge + 1) % poly.length];
        const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
        if (dist(pt, mid) <= 12) return { index: i, edge };
      }
    }
    return null;
  }

  canvas.addEventListener("click", (e) => {
	    if (!cam) return;
	    if (mode === "draw") {
	      if (isNearStart({ x: e.clientX, y: e.clientY })) {
	        finishPolygon();
	        return;
	      }
	      polygonLL.push(px2ll(e.clientX, e.clientY, cam));
	      redraw();
	      return;
	    }
    if (mode === "gate-entry" || mode === "gate-exit") {
      placeGate(mode === "gate-entry" ? "entry" : "exit", { x: e.clientX, y: e.clientY });
      return;
    }
    if (mode === "road-delete") {
      const index = hitAisle({ x: e.clientX, y: e.clientY });
      if (index < 0) return;
      aislesLL.splice(index, 1);
      setStatus("Yol silindi. Gerekirse yeni yerleşim için tekrar hesapla.");
      redraw();
      return;
    }
  });
	  canvas.addEventListener("pointerdown", (e) => {
	    if (mode !== "road" || !cam || e.button !== 0) return;
	    const pt = { x: e.clientX, y: e.clientY };
	    const cornerHit = hitAisleCorner(pt);
	    const edgeHit = cornerHit ? null : hitAisleEdge(pt);
	    const index = cornerHit ? cornerHit.index : edgeHit ? edgeHit.index : hitAisle(pt);
	    if (index < 0) return;
	    e.preventDefault();
	    canvas.setPointerCapture(e.pointerId);
	    canvas.style.cursor = cornerHit || edgeHit ? "nwse-resize" : "grabbing";
	    roadDrag = {
	      type: cornerHit ? "corner" : edgeHit ? "edge" : "move",
	      index,
	      corner: cornerHit ? cornerHit.corner : null,
	      edge: edgeHit ? edgeHit.edge : null,
	      pointerId: e.pointerId,
	      start: { x: e.clientX, y: e.clientY },
	      original: aislesLL[index].map((p) => ({ ...p })),
	    };
	  });
  canvas.addEventListener("pointermove", (e) => {
	    if (mode === "draw") {
	      cursor = { x: e.clientX, y: e.clientY };
	      canvas.style.cursor = isNearStart(cursor) ? "pointer" : "crosshair";
	      redraw();
	      return;
	    }
    if (mode !== "road" || !cam || !roadDrag || roadDrag.pointerId !== e.pointerId) return;
	    if (roadDrag.type === "corner") {
	      aislesLL[roadDrag.index] = roadDrag.original.map((ll, i) =>
	        i === roadDrag.corner ? px2ll(e.clientX, e.clientY, cam) : ll
	      );
	    } else if (roadDrag.type === "edge") {
	      const dx = e.clientX - roadDrag.start.x;
	      const dy = e.clientY - roadDrag.start.y;
	      const a = roadDrag.edge;
	      const b = (roadDrag.edge + 1) % 4;
	      aislesLL[roadDrag.index] = roadDrag.original.map((ll, i) => {
	        if (i !== a && i !== b) return ll;
	        const p = ll2px(ll, cam);
	        return px2ll(p.x + dx, p.y + dy, cam);
	      });
	    } else {
	      const dx = e.clientX - roadDrag.start.x;
	      const dy = e.clientY - roadDrag.start.y;
	      aislesLL[roadDrag.index] = roadDrag.original.map((ll) => {
	        const p = ll2px(ll, cam);
	        return px2ll(p.x + dx, p.y + dy, cam);
	      });
	    }
	    redraw();
	  });
  canvas.addEventListener("dblclick", () => { if (mode === "draw") finishPolygon(); });
  canvas.addEventListener("pointerup", (e) => {
    if (!roadDrag || roadDrag.pointerId !== e.pointerId) return;
    roadDrag = null;
    canvas.style.cursor = mode === "road" ? "grab" : "default";
  });
  canvas.addEventListener("pointercancel", () => {
    roadDrag = null;
    canvas.style.cursor = mode === "road" ? "grab" : "default";
  });

  // ---- Klavye ----
  window.addEventListener("keydown", (e) => {
    if (mode === "draw" && e.key === "Enter") finishPolygon();
    if (e.key === "Escape" && mode !== "idle") {
      mode = "idle";
      roadDrag = null;
      setInteractive(false);
      setStatus("Düzenleme kapatıldı.");
      redraw();
    }
  });

  // ---- Canlı kaydırma (pan) için anlık offset ----
  window.addEventListener("pointerdown", (e) => {
    if (mode !== "idle" || e.button !== 0 || panel.contains(e.target)) return;
    dragging = true;
    dragStart = { x: e.clientX, y: e.clientY };
  }, true);
  window.addEventListener("pointermove", (e) => {
    lastPointer = { x: e.clientX, y: e.clientY };
    if (!dragging) return;
    dragDelta = { x: e.clientX - dragStart.x, y: e.clientY - dragStart.y };
    canvas.style.transform = `translate(${dragDelta.x}px,${dragDelta.y}px)`;
  }, true);
  window.addEventListener("pointerup", () => { dragging = false; }, true);

  // ---- Panel butonları ----
  $("#opl-draw").addEventListener("click", startDraw);
  $("#opl-finish").addEventListener("click", finishPolygon);
  $("#opl-clear").addEventListener("click", clearAll);
  $("#opl-compute").addEventListener("click", compute);
  $("#opl-entry").addEventListener("click", () => startGate("entry"));
  $("#opl-exit").addEventListener("click", () => startGate("exit"));
  $("#opl-roadedit").addEventListener("click", startRoadEdit);
  $("#opl-roaddelete").addEventListener("click", startRoadDelete);

  // ---- Kamera takip döngüsü: URL değişince yeniden projeksiyonla ----
  let warned3D = false;
  function tick() {
    const c = getCamera();
    if (c) {
      // 2B (harita veya uydu): konum okunabiliyor → projeksiyon geçerli
      warned3D = false;
      if (!cam || c.lat !== cam.lat || c.lng !== cam.lng || c.zoom !== cam.zoom) {
        cam = c;
        dragDelta = { x: 0, y: 0 };
        canvas.style.transform = "";
        if (dragging) dragStart = { ...lastPointer }; // sürüş sırasında taban sıfırla
        updateScaleReadout();
        redraw();
      }
    } else if ((polygonLL.length || stallsLL.length) && !warned3D) {
      // 3B/eğik görünüm: düz projeksiyon hizalanamaz → son konumda dondur, silme
      warned3D = true;
      toast("3B/eğik görünüm: 2B'ye dönünce yerleşim otomatik hizalanır.");
      setStatus("3B görünümde hizalama duraklatıldı. 2B'ye dönünce düzelir.");
    }
    requestAnimationFrame(tick);
  }

  // ---- Başlat ----
  resize();
  cam = getCamera();
  updateScaleReadout();
  redraw();
  requestAnimationFrame(tick);
})();
