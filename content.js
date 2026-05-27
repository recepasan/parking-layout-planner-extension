// content.js — Google Maps üzerine coğrafi sabitlenmiş overlay + panel.
(function () {
  "use strict";
  if (window.__otoparkPlannerLoaded) return;
  window.__otoparkPlannerLoaded = true;
  console.log("[Parking Layout] content script loaded");

  const Z_CANVAS = 2147483646;
  const TILE = 256;

  // ---- Durum ----
  let mode = "idle";        // idle | draw | freehand | gate-entry | gate-exit | road | road-delete | addroad
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
  let aislesEdited = false; // yollar elle düzenlendi mi? (Hesapla'da sabit tut)
  let lastAngleDeg = 0;     // son tam optimizasyonun yön açısı (sınıflandırma için)
  let aisleSegsCache = [];  // koridor merkez çizgileri (bay'ın açık kenarını bulmak için)
  let freehandActive = false; // serbest çizim sırasında basılı mı?
  let freehandLastPx = null;  // son örneklenen serbest nokta (px)
  let roadPoints = [];        // "Yol Ekle" için bükülebilir yol merkez noktaları (LL)
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

  // ---- Dil / i18n (varsayılan: İngilizce) ----
  const I18N = {
    en: {
      title: "🅿️ Parking Layout (Test)",
      vertices: "Vertices", freehand: "Freehand", finish: "Finish",
      stallW: "Stall width (m)", stallD: "Stall depth (m)", aisle: "Aisle (m)", angleStep: "Angle step (°)",
      btb: "Back-to-back double", oneway: "One-way lane (3.5 m)",
      fillEmpty: "Fill empty areas",
      compute: "Compute Layout", clear: "Clear",
      entryGate: "Entry Gate", exitGate: "Exit Gate",
      addRoad: "Add Road", moveRoad: "Move Road", delRoad: "Delete Road",
      scaleCalc: "Calculating scale…",
      noLoc: "⚠ Location unreadable. Switch to top-down (2D) view.",
      scaleInfo: (m, z) => `Scale: ${m} m/px · zoom ${z}`,
      startHint: "Draw an area with 'Vertices' or 'Freehand'.",
      startVertices: "Click corners. Return to the start point to close.",
      startFreehand: "Hold and drag freely (oval/curved); release to close.",
      startAddRoad: "Click points for a road (can bend). Double-click / Finish, then Compute.",
      roadAdded: "Road added. 'Compute Layout' places stalls along it.",
      areaReady: "Area ready. Press 'Compute Layout'.",
      cleared: "Cleared. Start with 'Vertices' or 'Freehand'.",
      gatePrompt: (g) => `Click the boundary for the ${g} gate; it snaps to the nearest edge.`,
      startMoveRoad: "Drag a road, or grab yellow corners to resize. Esc to exit.",
      startDelRoad: "Click the gray road to delete. Esc to exit.",
      gatePlaced: (g) => `${g} gate set. You can recompute.`,
      computed: "Computed. Stalls open onto connected drive aisles.",
      roadMoved: "Road moved. 'Compute Layout' re-places stalls accordingly.",
      roadDeleted: "Road deleted. 'Compute' re-places stalls along remaining roads.",
      view3D: "3D/tilted view: returning to 2D re-aligns the layout.",
      view3Dstatus: "Alignment paused in 3D. Return to 2D to fix.",
      editClosed: "Editing closed.",
      tooShort: "Too short; try again.",
      needArea: "Draw an area first.",
      need3: "At least 3 corners needed.",
      finishAreaFirst: "Finish the area first.",
      computeFirst: "Compute the layout first.",
      gateTooFar: "Place the gate closer to the yellow boundary.",
      noScale: "No location/scale.",
      noLocDraw: "Location unreadable; switch to top-down 2D.",
      roadNeed2: "A road needs at least 2 points.",
      couldnt: "Couldn't compute.",
      gateEntry: "Entry", gateExit: "Exit",
      result: (n, ang, lane, area, per, ms) =>
        `<b>${n}</b> accessible stalls<br>Orientation: ${ang}° · Lane: ${lane} m · Area: ${area} m²<br>Efficiency: 1 car / ${per} m² · ${ms} ms`,
    },
    tr: {
      title: "🅿️ Otopark Yerleşim (Test)",
      vertices: "Köşeli", freehand: "Serbest", finish: "Bitir",
      stallW: "Park genişlik (m)", stallD: "Park derinlik (m)", aisle: "Koridor (m)", angleStep: "Açı adımı (°)",
      btb: "Sırt sırta çift park", oneway: "Tek şerit yol (3.5 m)",
      fillEmpty: "Boş alanları doldur",
      compute: "Yerleşimi Hesapla", clear: "Temizle",
      entryGate: "Giriş Kapısı", exitGate: "Çıkış Kapısı",
      addRoad: "Yol Ekle", moveRoad: "Yol Taşı", delRoad: "Yol Sil",
      scaleCalc: "Ölçek hesaplanıyor…",
      noLoc: "⚠ Konum okunamadı. Üstten (2B) görünüme geçin.",
      scaleInfo: (m, z) => `Ölçek: ${m} m/piksel · zoom ${z}`,
      startHint: "'Köşeli' veya 'Serbest' ile bir alan çiz.",
      startVertices: "Köşeleri tıkla. Başlangıç noktasına dönünce kapanır.",
      startFreehand: "Basılı tutup serbestçe çiz (oval/eğri); bırakınca kapanır.",
      startAddRoad: "Yol için noktalara tıkla (bükülebilir). Çift tık / Bitir, sonra Hesapla.",
      roadAdded: "Yol eklendi. 'Yerleşimi Hesapla' park yerlerini bu yola göre dizer.",
      areaReady: "Alan hazır. 'Yerleşimi Hesapla'ya bas.",
      cleared: "Temizlendi. 'Köşeli' veya 'Serbest' ile başla.",
      gatePrompt: (g) => `${g} kapısı için alan sınırına tıkla; nokta en yakın kenara oturur.`,
      startMoveRoad: "Yolu taşı veya sarı köşelerden tutup boyutlandır. Escape ile çık.",
      startDelRoad: "Silmek istediğin gri yola tıkla. Escape ile çık.",
      gatePlaced: (g) => `${g} kapısı seçildi. Yerleşimi tekrar hesaplayabilirsin.`,
      computed: "Hesaplandı. Park cepleri bağlı sürüş koridorlarına açılır.",
      roadMoved: "Yol taşındı. 'Yerleşimi Hesapla' park yerlerini yeniden dizer.",
      roadDeleted: "Yol silindi. 'Hesapla' kalan yollara göre yeniden dizer.",
      view3D: "3B/eğik görünüm: 2B'ye dönünce yerleşim otomatik hizalanır.",
      view3Dstatus: "3B görünümde hizalama duraklatıldı. 2B'ye dönünce düzelir.",
      editClosed: "Düzenleme kapatıldı.",
      tooShort: "Çok kısa; tekrar dene.",
      needArea: "Önce bir alan çiz.",
      need3: "En az 3 köşe gerekli.",
      finishAreaFirst: "Önce alanı bitir.",
      computeFirst: "Önce yerleşimi hesapla.",
      gateTooFar: "Kapıyı sarı alan sınırına daha yakın seç.",
      noScale: "Konum/ölçek yok.",
      noLocDraw: "Konum okunamadı; üstten 2B görünüme geç.",
      roadNeed2: "Yol için en az 2 nokta gerekli.",
      couldnt: "Hesaplanamadı.",
      gateEntry: "Giriş", gateExit: "Çıkış",
      result: (n, ang, lane, area, per, ms) =>
        `<b>${n}</b> erişilebilir araç kapasitesi<br>Yön: ${ang}° · Yol: ${lane} m · Alan: ${area} m²<br>Verim: 1 araç / ${per} m² · ${ms} ms`,
    },
  };
  let lang = "en";
  try { const s = localStorage.getItem("opl-lang"); if (s === "tr" || s === "en") lang = s; } catch (e) {}
  const t = (k, ...a) => {
    const v = (I18N[lang] && I18N[lang][k] != null) ? I18N[lang][k] : I18N.en[k];
    return typeof v === "function" ? v(...a) : (v != null ? v : k);
  };

  // ---- Panel ----
  const panel = document.createElement("div");
  panel.id = "opl-panel";
  panel.innerHTML = `
    <div class="opl-head">
      <h1 data-i18n="title"></h1>
      <button id="opl-lang" class="opl-lang"></button>
    </div>
    <div class="opl-scale" id="opl-scale"></div>
    <div class="opl-row">
      <button id="opl-draw" data-i18n="vertices"></button>
      <button id="opl-freehand" data-i18n="freehand"></button>
      <button id="opl-finish" class="opl-secondary" data-i18n="finish"></button>
    </div>
    <div class="opl-fields">
      <label><span data-i18n="stallW"></span><input id="opl-sw" type="number" step="0.1" value="2.5"></label>
      <label><span data-i18n="stallD"></span><input id="opl-sd" type="number" step="0.1" value="5.0"></label>
      <label><span data-i18n="aisle"></span><input id="opl-aw" type="number" step="0.1" value="6.0"></label>
      <label><span data-i18n="angleStep"></span><input id="opl-as" type="number" step="5" value="10"></label>
    </div>
    <label class="opl-check"><input id="opl-btb" type="checkbox" checked> <span data-i18n="btb"></span></label>
    <label class="opl-check"><input id="opl-singlelane" type="checkbox"> <span data-i18n="oneway"></span></label>
    <label class="opl-check"><input id="opl-fillempty" type="checkbox"> <span data-i18n="fillEmpty"></span></label>
    <div class="opl-row">
      <button id="opl-compute" data-i18n="compute"></button>
      <button id="opl-clear" class="opl-danger" data-i18n="clear"></button>
    </div>
    <div class="opl-row">
      <button id="opl-entry" class="opl-secondary" data-i18n="entryGate"></button>
      <button id="opl-exit" class="opl-secondary" data-i18n="exitGate"></button>
    </div>
    <div class="opl-row">
      <button id="opl-roadadd" class="opl-secondary" data-i18n="addRoad"></button>
      <button id="opl-roadedit" class="opl-secondary" data-i18n="moveRoad"></button>
      <button id="opl-roaddelete" class="opl-danger" data-i18n="delRoad"></button>
    </div>
    <div class="opl-result" id="opl-result" style="display:none"></div>
    <div class="opl-status" id="opl-status"></div>
  `;
  document.body.appendChild(panel);

  const $ = (id) => panel.querySelector(id);
  const statusEl = $("#opl-status");
  const resultEl = $("#opl-result");
  const scaleEl = $("#opl-scale");
  const setStatus = (txt) => (statusEl.textContent = txt);

  // Tüm statik etiketleri seçili dile göre güncelle.
  function applyLang() {
    panel.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    const lb = $("#opl-lang");
    if (lb) lb.textContent = lang === "en" ? "TR" : "EN";
    updateScaleReadout();
    if (result) renderResult();
  }

  function updateScaleReadout() {
    if (!cam) {
      scaleEl.textContent = t("noLoc");
      return;
    }
    scaleEl.textContent = t("scaleInfo", mppFromCam(cam).toFixed(3), cam.zoom);
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
    return type === "entry" ? t("gateEntry") : t("gateExit");
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
    // Gerçek genişlik = kısa kenar (dikey/yatay koridor fark etmez).
    const s1 = (dist(a[0], a[1]) + dist(a[2], a[3])) / 2;
    const s2 = (dist(a[0], a[3]) + dist(a[1], a[2])) / 2;
    return Math.min(s1, s2) * mppFromCam(cam);
  }

  function aisleLengthM(a) {
    if (!cam) return 0;
    const lPx = (dist(a[0], a[1]) + dist(a[3], a[2])) / 2;
    return lPx * mppFromCam(cam);
  }

  function classifyStalls(stallsPx, angleDeg, mpp, gatePts) {
    const n = stallsPx.length;
    const types = stallsPx.map(() => "standard");
    if (!n) return types;

    // Bayları, yerleşim açısına göre döndürülmüş çerçevede konumlandır.
    // "aligned": iç (eksene hizalı) baylar; "değil": eğik kenar bayları.
    const ang = -((angleDeg || 0) * Math.PI) / 180;
    const cos = Math.cos(ang), sin = Math.sin(ang);
    const layoutRad = ((angleDeg || 0) * Math.PI) / 180;
    const info = stallsPx.map((st, index) => {
      const c = centroid(st);
      const e = Math.atan2(st[1].y - st[0].y, st[1].x - st[0].x);
      let d = Math.abs((e - layoutRad) % (Math.PI / 2));
      if (d > Math.PI / 4) d = Math.PI / 2 - d;
      return { index, c, rx: c.x * cos - c.y * sin, ry: c.x * sin + c.y * cos, aligned: d < 0.2 };
    });

    // 1) Sıralara böl (döndürülmüş ry'ye göre) ve peyzaj adalarını
    //    rastgele değil, uzun sıraların UÇLARINA yerleştir.
    const pxPerM = 1 / mpp;
    const rowTol = (parseFloat($("#opl-sd").value) || 5) * pxPerM * 0.6;
    const sorted = info.filter((it) => it.aligned).sort((a, b) => a.ry - b.ry || a.rx - b.rx);
    const rows = [];
    let cur = [];
    for (const it of sorted) {
      if (cur.length && it.ry - cur[cur.length - 1].ry > rowTol) { rows.push(cur); cur = []; }
      cur.push(it);
    }
    if (cur.length) rows.push(cur);
    for (const row of rows) {
      row.sort((a, b) => a.rx - b.rx);
      if (row.length >= 10) {
        types[row[0].index] = "landscape";
        types[row[row.length - 1].index] = "landscape";
      }
      if (row.length >= 24) types[row[Math.floor(row.length / 2)].index] = "landscape";
    }

    // 2) Engelli baylar: girişe (yoksa lotun ön kenarına) en yakın bitişik blok.
    const gpts = gatePts || [];
    const entry = gpts.find((g) => g.type === "entry") || gpts[0];
    const frontBay = info.reduce((m, it) => (it.ry < m.ry ? it : m), info[0]);
    const accAnchor = entry ? entry.point : frontBay.c;
    // EV baylar: çıkışa (yoksa karşı kenara) yakın ayrı bir blok.
    const exit = gpts.find((g) => g.type === "exit");
    const sideBay = info.reduce((m, it) => (it.rx > m.rx ? it : m), info[0]);
    const evAnchor = exit ? exit.point : sideBay.c;

    function tagNearest(anchor, count, type) {
      const cand = info
        .filter((it) => it.aligned && types[it.index] === "standard")
        .sort((a, b) =>
          Math.hypot(a.c.x - anchor.x, a.c.y - anchor.y) -
          Math.hypot(b.c.x - anchor.x, b.c.y - anchor.y));
      for (const it of cand.slice(0, count)) types[it.index] = type;
    }
    tagNearest(accAnchor, Math.min(8, Math.max(4, Math.ceil(n * 0.04))), "accessible");
    tagNearest(evAnchor, Math.min(12, Math.max(4, Math.ceil(n * 0.06))), "ev");

    return types;
  }

  function parkingCount() {
    return stallTypes.filter((t) => t !== "landscape").length || stallsLL.length;
  }

  function renderResult() {
    if (!result) return;
    const count = parkingCount();
    const perCar = count ? (result.areaM2 / count).toFixed(1) : "—";
    resultEl.innerHTML = t(
      "result", count, result.angleDeg,
      (result.laneM != null ? result.laneM : 0).toFixed(1),
      result.areaM2.toFixed(0), perCar, result.ms != null ? result.ms : "—"
    );
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
    // orta çizgi (kesikli): koridorun UZUN ekseni boyunca (yatay/dikey fark etmez)
    const side01 = (dist(a[0], a[1]) + dist(a[3], a[2])) / 2;
    const side03 = (dist(a[0], a[3]) + dist(a[1], a[2])) / 2;
    let m1, m2;
    if (side01 >= side03) {
      m1 = { x: (a[0].x + a[3].x) / 2, y: (a[0].y + a[3].y) / 2 };
      m2 = { x: (a[1].x + a[2].x) / 2, y: (a[1].y + a[2].y) / 2 };
    } else {
      m1 = { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2 };
      m2 = { x: (a[3].x + a[2].x) / 2, y: (a[3].y + a[2].y) / 2 };
    }
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
    const lenM = len * mppFromCam(cam); // koridorun uzunluğu (metre)
    const angle = Math.atan2(dy, dx);

    // Oklar yalnızca yeterince uzun koridorlarda (kalabalığı önlemek için).
    if (lenM > 9) {
      const arrows = Math.max(1, Math.floor(len / 120));
      ctx.fillStyle = "rgba(255,235,120,0.78)";
      const reverse = (index % 2) === 1; // tek yönlü akış, komşuda ters
      for (let i = 1; i <= arrows; i++) {
        const t = i / (arrows + 1);
        const x = m1.x + dx * t, y = m1.y + dy * t;
        const rot = reverse ? angle + Math.PI : angle;
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
    }

    // Ölçü etiketi yalnızca uzun koridorlarda.
    if (lenM > 12) {
      const label = `${aisleWidthM(a).toFixed(1)} m`;
      const lc = centroid(a);
      ctx.save();
      ctx.translate(lc.x, lc.y);
      ctx.rotate(angle);
      ctx.font = "700 10px -apple-system, Segoe UI, Roboto, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const tw = ctx.measureText(label).width + 12;
      ctx.fillStyle = "rgba(20,22,28,0.58)";
      ctx.beginPath();
      ctx.roundRect(-tw / 2, -10, tw, 20, 5);
      ctx.fill();
      ctx.fillStyle = "rgba(254,243,199,0.92)";
      ctx.fillText(label, 0, 0);
      ctx.restore();
    }

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
    }
  }

  // Tek bir park cebini plan stiliyle (ince beyaz çizgi) çizer.
  function drawBay(st, type) {
    let cx = 0, cy = 0;
    for (const p of st) { cx += p.x; cy += p.y; }
    cx /= 4; cy /= 4;

    if (type === "landscape") {
      // Sıra ucu peyzaj/ağaç adası: yalnızca yeşil daire (referanstaki gibi).
      const r = Math.max(4, Math.min(9, Math.hypot(st[1].x - st[0].x, st[1].y - st[0].y) * 0.45));
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(34,139,58,0.92)";
      ctx.fill();
      ctx.strokeStyle = "rgba(20,60,30,0.55)";
      ctx.lineWidth = 1;
      ctx.stroke();
      return;
    }

    // Dolgu (yalnızca engelli/EV) — önce kapalı yolu doldur.
    if (type === "accessible" || type === "ev") {
      ctx.beginPath();
      st.forEach((p, i) => { i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
      ctx.closePath();
      ctx.fillStyle = type === "accessible" ? "rgba(37,99,235,0.82)" : "rgba(34,197,94,0.78)";
      ctx.fill();
    }

    // Tarak stili: koridora bakan kenarı AÇIK bırak, diğer 3 kenarı çiz.
    let open = -1, bestD = Infinity;
    for (let i = 0; i < 4 && aisleSegsCache.length; i++) {
      const a = st[i], b = st[(i + 1) % 4];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      for (const seg of aisleSegsCache) {
        const np = segNearest(mid, seg.m1, seg.m2);
        const d = Math.hypot(mid.x - np.x, mid.y - np.y);
        if (d < bestD) { bestD = d; open = i; }
      }
    }
    ctx.strokeStyle = "rgba(255,255,255,0.72)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (open >= 0) {
      let idx = (open + 1) % 4;
      ctx.moveTo(st[idx].x, st[idx].y);
      for (let k = 0; k < 3; k++) { idx = (idx + 1) % 4; ctx.lineTo(st[idx].x, st[idx].y); }
    } else {
      st.forEach((p, i) => { i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
      ctx.closePath();
    }
    ctx.stroke();

    if (type === "accessible") {
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.font = "700 9px -apple-system, Segoe UI, Roboto, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("P", cx, cy);
    }
  }

  function segNearest(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    return { x: a.x + dx * t, y: a.y + dy * t };
  }

  // Kapıyı en yakın sürüş koridoruna bağlayan erişim yolu + yön oku.
  function drawGateAccess(gate, g) {
    if (!aislesLL.length) return;
    let best = null;
    for (const aLL of aislesLL) {
      const a = aLL.map((ll) => ll2px(ll, cam));
      const m1 = { x: (a[0].x + a[3].x) / 2, y: (a[0].y + a[3].y) / 2 };
      const m2 = { x: (a[1].x + a[2].x) / 2, y: (a[1].y + a[2].y) / 2 };
      const np = segNearest(g, m1, m2);
      const d = dist(g, np);
      const w = (dist(a[0], a[3]) + dist(a[1], a[2])) / 2;
      if (!best || d < best.d) best = { d, np, w };
    }
    if (!best) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(119,128,136,0.9)";
    ctx.lineWidth = Math.max(8, best.w * 0.9);
    ctx.beginPath();
    ctx.moveTo(g.x, g.y);
    ctx.lineTo(best.np.x, best.np.y);
    ctx.stroke();
    const ang = Math.atan2(best.np.y - g.y, best.np.x - g.x);
    const into = gate.type === "entry";
    ctx.translate(into ? best.np.x : g.x, into ? best.np.y : g.y);
    ctx.rotate(into ? ang : ang + Math.PI);
    ctx.fillStyle = "rgba(255,235,120,0.95)";
    ctx.beginPath();
    ctx.moveTo(9, 0); ctx.lineTo(-6, -5); ctx.lineTo(-6, 5); ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawGate(gate) {
    const p = ll2px(gate.ll, cam);
    const color = gate.type === "entry" ? "#22c55e" : "#ef4444";
    drawGateAccess(gate, p);
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
    // Koridor merkez çizgilerini (uzun eksen) bir kez hesapla → bay'ların açık kenarı.
    aisleSegsCache = aislesLL.map((aLL) => {
      const a = aLL.map((ll) => ll2px(ll, cam));
      const s01 = dist(a[0], a[1]) + dist(a[3], a[2]);
      const s03 = dist(a[0], a[3]) + dist(a[1], a[2]);
      return s01 >= s03
        ? { m1: { x: (a[0].x + a[3].x) / 2, y: (a[0].y + a[3].y) / 2 }, m2: { x: (a[1].x + a[2].x) / 2, y: (a[1].y + a[2].y) / 2 } }
        : { m1: { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2 }, m2: { x: (a[3].x + a[2].x) / 2, y: (a[3].y + a[2].y) / 2 } };
    });

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

	    // "Yol Ekle" önizlemesi: bükülebilir yol merkez çizgisi + genişlik şeridi
	    if (mode === "addroad" && roadPoints.length) {
	      const rp = roadPoints.map((ll) => ll2px(ll, cam));
	      const ends = cursor ? rp.concat([cursor]) : rp;
	      const singleLane = $("#opl-singlelane").checked;
	      const wM = singleLane ? 3.5 : (parseFloat($("#opl-aw").value) || 6.0);
	      ctx.lineCap = "round"; ctx.lineJoin = "round";
	      ctx.strokeStyle = "rgba(119,128,136,0.65)";
	      ctx.lineWidth = wM / mppFromCam(cam);
	      ctx.beginPath();
	      ctx.moveTo(ends[0].x, ends[0].y);
	      for (let i = 1; i < ends.length; i++) ctx.lineTo(ends[i].x, ends[i].y);
	      ctx.stroke();
	      ctx.strokeStyle = "rgba(255,235,120,0.9)";
	      ctx.lineWidth = 1.5; ctx.setLineDash([8, 6]);
	      ctx.beginPath();
	      ctx.moveTo(ends[0].x, ends[0].y);
	      for (let i = 1; i < ends.length; i++) ctx.lineTo(ends[i].x, ends[i].y);
	      ctx.stroke();
	      ctx.setLineDash([]); ctx.lineCap = "butt"; ctx.lineJoin = "miter";
	      ctx.fillStyle = "#ffd400";
	      for (const p of rp) { ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, 7); ctx.fill(); }
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
	      if (mode !== "freehand") for (const p of pts) { ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, 7); ctx.fill(); }
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
  function resetAll() {
    polygonLL = []; closed = false; stallsLL = []; stallTypes = []; aislesLL = []; gatesLL = []; result = null;
    aislesEdited = false; roadPoints = []; freehandActive = false; freehandLastPx = null;
    dragDelta = { x: 0, y: 0 }; canvas.style.transform = "";
    resultEl.style.display = "none";
  }
  function startDraw() {
    if (!cam) { toast(t("noLocDraw")); return; }
    resetAll();
    mode = "draw";
    setInteractive(true);
    setStatus(t("startVertices"));
    redraw();
  }
  function startFreehand() {
    if (!cam) { toast(t("noLocDraw")); return; }
    resetAll();
    mode = "freehand";
    setInteractive(true);
    setStatus(t("startFreehand"));
    redraw();
  }
  function startAddRoad() {
    if (!cam) { toast(t("noScale")); return; }
    if (!closed || polygonLL.length < 3) { toast(t("needArea")); return; }
    mode = "addroad";
    roadPoints = [];
    roadDrag = null;
    setInteractive(true);
    setStatus(t("startAddRoad"));
    redraw();
  }
  function finishAddRoad() {
    if (roadPoints.length < 2) { toast(t("roadNeed2")); roadPoints = []; mode = "idle"; setInteractive(false); redraw(); return; }
    const singleLane = $("#opl-singlelane").checked;
    const wM = singleLane ? 3.5 : (parseFloat($("#opl-aw").value) || 6.0);
    const halfPx = (wM / mppFromCam(cam)) / 2;
    // Her segmenti, genişliği koridor kadar olan bir dikdörtgen (quad) yap.
    for (let i = 0; i < roadPoints.length - 1; i++) {
      const p0 = ll2px(roadPoints[i], cam);
      const p1 = ll2px(roadPoints[i + 1], cam);
      const dx = p1.x - p0.x, dy = p1.y - p0.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len * halfPx, ny = dx / len * halfPx; // dik normal
      const quad = [
        { x: p0.x + nx, y: p0.y + ny }, { x: p1.x + nx, y: p1.y + ny },
        { x: p1.x - nx, y: p1.y - ny }, { x: p0.x - nx, y: p0.y - ny },
      ];
      aislesLL.push(quad.map((p) => px2ll(p.x, p.y, cam)));
    }
    aislesEdited = true;
    roadPoints = [];
    mode = "idle";
    setInteractive(false);
    setStatus(t("roadAdded"));
    redraw();
  }
  function finishPolygon() {
    if (polygonLL.length < 3) { toast(t("need3")); return; }
    closed = true;
    mode = "idle";
    setInteractive(false);
    setStatus(t("areaReady"));
    redraw();
  }
  function clearAll() {
    resetAll();
    mode = "idle";
    setInteractive(false);
    setStatus(t("cleared"));
    redraw();
  }
  function startGate(type) {
    if (!closed || polygonLL.length < 3) { toast(t("finishAreaFirst")); return; }
    mode = type === "entry" ? "gate-entry" : "gate-exit";
    roadDrag = null;
    setInteractive(true);
    setStatus(t("gatePrompt", gateLabel(type)));
    redraw();
  }
  function startRoadEdit() {
    if (!aislesLL.length) { toast(t("computeFirst")); return; }
    mode = "road";
    roadDrag = null;
    setInteractive(true);
    setStatus(t("startMoveRoad"));
    redraw();
  }
  function startRoadDelete() {
    if (!aislesLL.length) { toast(t("computeFirst")); return; }
    mode = "road-delete";
    roadDrag = null;
    setInteractive(true);
    setStatus(t("startDelRoad"));
    redraw();
  }
  function placeGate(type, pt) {
    if (!cam || !closed || polygonLL.length < 3) return;
    const poly = polygonLL.map((ll) => ll2px(ll, cam));
    const snapped = nearestBoundaryPoint(pt, poly);
    if (!snapped || snapped.dist > 36) {
      toast(t("gateTooFar"));
      return;
    }
    const ll = px2ll(snapped.x, snapped.y, cam);
    gatesLL = gatesLL.filter((g) => g.type !== type).concat({ type, ll });
    setStatus(t("gatePlaced", gateLabel(type)));
    mode = "idle";
    setInteractive(false);
    redraw();
  }
	  function compute() {
	    if (!closed || polygonLL.length < 3) { toast(t("needArea")); return; }
	    if (!cam) { toast(t("noScale")); return; }
	    const singleLane = $("#opl-singlelane").checked;
	    const aisleWidthM = singleLane ? 3.5 : (parseFloat($("#opl-aw").value) || 6.0);

	    // --- ZOOM'DAN BAĞIMSIZ sabit referans ölçek ---
	    // Hesabı her zaman aynı ölçekte yap; sonuç görüntü zoom'una göre değişmesin.
	    const REF_ZOOM = 20;
	    const REF = TILE * Math.pow(2, REF_ZOOM);
	    const refLat = polygonLL[0].lat;
	    const mppRef = (156543.03392 * Math.cos((refLat * Math.PI) / 180)) / Math.pow(2, REF_ZOOM);
	    const o = project(polygonLL[0].lat, polygonLL[0].lng, REF); // yerel köken (global mercator px)
	    const toL = (ll) => { const w = project(ll.lat, ll.lng, REF); return { x: w.x - o.x, y: w.y - o.y }; };
	    const fromL = (p) => {
	      const gx = p.x + o.x, gy = p.y + o.y;
	      const lng = (gx / REF) * 360 - 180;
	      const latRad = 2 * Math.atan(Math.exp(Math.PI * (1 - (2 * gy) / REF))) - Math.PI / 2;
	      return { lat: (latRad * 180) / Math.PI, lng };
	    };

	    const opts = {
	      stallWidthM: parseFloat($("#opl-sw").value) || 2.5,
	      stallDepthM: parseFloat($("#opl-sd").value) || 5.0,
	      aisleWidthM,
	      angleStepDeg: Math.max(5, parseFloat($("#opl-as").value) || 15),
	      gates: gatesLL.map((g) => ({ type: g.type, point: toL(g.ll) })),
	      backToBack: $("#opl-btb").checked,
	      fillEmpty: $("#opl-fillempty").checked,
	    };
    const polyRef = polygonLL.map(toL);
    const t0 = performance.now();
    let r;
    if (aislesEdited && aislesLL.length) {
      // Yollar elle düzenlendi → koridorları sabit tut, bayları yeniden diz.
      const aisleQuads = aislesLL.map((a) => a.map(toL));
      r = fillBaysForAisles(polyRef, mppRef, opts, aisleQuads);
      if (r) r.angleDeg = lastAngleDeg;
    } else {
      r = computeBestLayout(polyRef, mppRef, opts);
      if (r) lastAngleDeg = r.angleDeg;
    }
    const ms = (performance.now() - t0).toFixed(0);
    if (!r) { toast(t("couldnt")); return; }
    // Sonuçları referans çerçeveden coğrafi koordinata çevirerek sakla.
    stallsLL = r.stalls.map((st) => st.map(fromL));
    stallTypes = classifyStalls(r.stalls, r.angleDeg, mppRef, opts.gates);
    aislesLL = r.aisles.map((a) => a.map(fromL));
    const effectiveCount = parkingCount();
    result = { count: effectiveCount, angleDeg: r.angleDeg, areaM2: r.areaM2, laneM: aisleWidthM, ms };
    redraw();
    resultEl.style.display = "block";
    renderResult();
    setStatus(t("computed"));
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
    if (mode === "addroad") {
      roadPoints.push(px2ll(e.clientX, e.clientY, cam));
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
      aislesEdited = true;
      setStatus(t("roadDeleted"));
      redraw();
      return;
    }
  });
	  canvas.addEventListener("pointerdown", (e) => {
	    if (mode === "freehand" && cam && e.button === 0) {
	      e.preventDefault();
	      canvas.setPointerCapture(e.pointerId);
	      freehandActive = true;
	      const p = { x: e.clientX, y: e.clientY };
	      polygonLL = [px2ll(p.x, p.y, cam)];
	      freehandLastPx = p;
	      closed = false;
	      redraw();
	      return;
	    }
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
	    if (mode === "freehand") {
	      cursor = { x: e.clientX, y: e.clientY };
	      if (freehandActive && cam) {
	        if (!freehandLastPx || Math.hypot(e.clientX - freehandLastPx.x, e.clientY - freehandLastPx.y) > 5) {
	          polygonLL.push(px2ll(e.clientX, e.clientY, cam));
	          freehandLastPx = { x: e.clientX, y: e.clientY };
	        }
	      }
	      redraw();
	      return;
	    }
	    if (mode === "draw" || mode === "addroad") {
	      cursor = { x: e.clientX, y: e.clientY };
	      canvas.style.cursor = (mode === "draw" && isNearStart(cursor)) ? "pointer" : "crosshair";
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
  canvas.addEventListener("dblclick", () => {
    if (mode === "draw") finishPolygon();
    else if (mode === "addroad") finishAddRoad();
  });
  canvas.addEventListener("pointerup", (e) => {
    if (mode === "freehand" && freehandActive) {
      freehandActive = false;
      if (polygonLL.length >= 3) finishPolygon();
      else { setStatus(t("tooShort")); redraw(); }
      return;
    }
    if (!roadDrag || roadDrag.pointerId !== e.pointerId) return;
    roadDrag = null;
    aislesEdited = true; // yol elle taşındı → Hesapla'da sabit tut
    setStatus(t("roadMoved"));
    canvas.style.cursor = mode === "road" ? "grab" : "default";
  });
  canvas.addEventListener("pointercancel", () => {
    roadDrag = null;
    freehandActive = false;
    canvas.style.cursor = mode === "road" ? "grab" : "default";
  });

  // ---- Klavye ----
  window.addEventListener("keydown", (e) => {
    if (mode === "draw" && e.key === "Enter") finishPolygon();
    if (mode === "addroad" && e.key === "Enter") finishAddRoad();
    if (e.key === "Escape" && mode !== "idle") {
      mode = "idle";
      roadDrag = null;
      roadPoints = [];
      freehandActive = false;
      setInteractive(false);
      setStatus(t("editClosed"));
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
  $("#opl-lang").addEventListener("click", () => {
    lang = lang === "en" ? "tr" : "en";
    try { localStorage.setItem("opl-lang", lang); } catch (e) {}
    applyLang();
    setStatus(closed ? t("areaReady") : t("startHint"));
  });
  $("#opl-draw").addEventListener("click", startDraw);
  $("#opl-freehand").addEventListener("click", startFreehand);
  $("#opl-roadadd").addEventListener("click", startAddRoad);
  $("#opl-finish").addEventListener("click", () => {
    if (mode === "addroad") finishAddRoad();
    else finishPolygon();
  });
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
      toast(t("view3D"));
      setStatus(t("view3Dstatus"));
    }
    requestAnimationFrame(tick);
  }

  // ---- Başlat ----
  applyLang();
  setStatus(t("startHint"));
  resize();
  cam = getCamera();
  updateScaleReadout();
  redraw();
  requestAnimationFrame(tick);
})();
