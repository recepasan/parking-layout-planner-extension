// tkgm-content.js — TKGM seçili parselini yerel otopark motoruna bağlayan izole içerik betiği.
(function () {
  "use strict";
  if (window.__oplTkgmContentLoaded) return;
  window.__oplTkgmContentLoaded = true;
  console.log("[Parking Layout] TKGM content script loaded");

  const SOURCE = "opl-tkgm-bridge";
  const VERSION = 1;
  const geometryApi = globalThis.OPLTKGMGeometry;
  if (!geometryApi || typeof computeBestLayout !== "function") {
    console.error("[Parking Layout] TKGM dependencies unavailable");
    return;
  }

  let bridgeReady = false;
  let parcel = null;
  let projection = null;
  let result = null;
  let lang = "en";
  try {
    const saved = localStorage.getItem("opl-lang");
    if (saved === "tr" || saved === "en") lang = saved;
  } catch (error) {}

  const I18N = {
    en: {
      title: "🅿️ Parking Layout · TKGM",
      source: "Uses only the parcel selected on this TKGM page. Processing stays in your browser.",
      useSelected: "Use Selected Parcel",
      compute: "Compute Layout",
      clear: "Clear Layout",
      stallW: "Stall width (m)", stallD: "Stall depth (m)", aisle: "Aisle (m)", angleStep: "Angle step (°)",
      btb: "Back-to-back double", oneway: "One-way lane (3.5 m)", fillEmpty: "Fill empty areas",
      waitingBridge: "Connecting to the TKGM map…",
      noSelection: "Select a parcel on the TKGM map, then click “Use Selected Parcel”.",
      selected: (label, vertices, area) => `${label} · ${vertices} vertices · approx. ${area} m²`,
      ready: "Parcel ready. You can compute the layout.",
      selectionCleared: "TKGM cleared the selected parcel.",
      invalidNumber: (label, min, max) => `${label} must be a finite number from ${min} to ${max}.`,
      invalidArea: "The parcel is invalid, self-intersecting, too small, or exceeds the calculation budget.",
      multipolygon: "Multi-part parcels are not supported. Select a single Polygon parcel.",
      holes: "Parcels containing interior holes are not supported; no unsafe simplification was applied.",
      tooMany: "The parcel exceeds the 512-vertex safety limit.",
      badGeometry: "The selected TKGM geometry could not be validated.",
      bridgeChanged: "The TKGM interface may have changed. Reload the page and select the parcel again.",
      renderFailed: "The layout was computed but could not be drawn on the TKGM map.",
      cleared: "Layout cleared. The selected parcel is still available.",
      warningDisconnected: (stalls, aisles) => `Disconnected components removed: ${stalls} spaces, ${aisles} aisles.`,
      warningOutside: (stalls, aisles) => `Outside geometry removed: ${stalls} spaces, ${aisles} aisles.`,
      warningUnknown: "The layout engine returned a warning.",
      result: (total, accessible, ev, angle, lane, area, perCar, ms, warning) =>
        `<b>${total}</b> total parking spaces<br>Estimated marked: ${accessible} accessible · ${ev} EV<br>Orientation: ${angle}° · Lane: ${lane} m · Area: ${area} m²<br>Efficiency: 1 car / ${perCar} m² · ${ms} ms${warning ? `<br>⚠ ${warning}` : ""}`,
      computed: "Computed locally and drawn as a Leaflet overlay.",
      parcelFallback: "Selected parcel",
    },
    tr: {
      title: "🅿️ Otopark Yerleşimi · TKGM",
      source: "Yalnız bu TKGM sayfasında seçtiğiniz parsel kullanılır. İşlem tarayıcınızda kalır.",
      useSelected: "Seçili Parseli Kullan",
      compute: "Yerleşimi Hesapla",
      clear: "Yerleşimi Temizle",
      stallW: "Park genişlik (m)", stallD: "Park derinlik (m)", aisle: "Koridor (m)", angleStep: "Açı adımı (°)",
      btb: "Sırt sırta çift park", oneway: "Tek şerit yol (3.5 m)", fillEmpty: "Boş alanları doldur",
      waitingBridge: "TKGM haritasına bağlanılıyor…",
      noSelection: "TKGM haritasından bir parsel seçin, sonra “Seçili Parseli Kullan”a basın.",
      selected: (label, vertices, area) => `${label} · ${vertices} köşe · yaklaşık ${area} m²`,
      ready: "Parsel hazır. Yerleşimi hesaplayabilirsiniz.",
      selectionCleared: "TKGM seçili parseli temizledi.",
      invalidNumber: (label, min, max) => `${label}, ${min} ile ${max} arasında sonlu bir sayı olmalı.`,
      invalidArea: "Parsel geçersiz, kendiyle kesişiyor, çok küçük veya hesaplama bütçesini aşıyor.",
      multipolygon: "Çok parçalı parseller desteklenmiyor. Tek Polygon olan bir parsel seçin.",
      holes: "İç boşluk içeren parseller desteklenmiyor; güvenli olmayan sadeleştirme yapılmadı.",
      tooMany: "Parsel 512 köşelik güvenlik sınırını aşıyor.",
      badGeometry: "Seçilen TKGM geometrisi doğrulanamadı.",
      bridgeChanged: "TKGM arayüzü değişmiş olabilir. Sayfayı yenileyip parseli tekrar seçin.",
      renderFailed: "Yerleşim hesaplandı ancak TKGM haritasına çizilemedi.",
      cleared: "Yerleşim temizlendi. Seçili parsel kullanılmaya devam edebilir.",
      warningDisconnected: (stalls, aisles) => `Bağlantısız bileşenler kaldırıldı: ${stalls} park yeri, ${aisles} koridor.`,
      warningOutside: (stalls, aisles) => `Parsel dışındaki geometri kaldırıldı: ${stalls} park yeri, ${aisles} koridor.`,
      warningUnknown: "Yerleşim motoru bir uyarı döndürdü.",
      result: (total, accessible, ev, angle, lane, area, perCar, ms, warning) =>
        `<b>${total}</b> toplam park yeri<br>Tahmini işaretli: ${accessible} erişilebilir · ${ev} EV<br>Yön: ${angle}° · Yol: ${lane} m · Alan: ${area} m²<br>Verim: 1 araç / ${perCar} m² · ${ms} ms${warning ? `<br>⚠ ${warning}` : ""}`,
      computed: "Tarayıcıda hesaplandı ve Leaflet katmanı olarak çizildi.",
      parcelFallback: "Seçili parsel",
    },
  };
  const t = (key, ...args) => {
    const value = I18N[lang][key] != null ? I18N[lang][key] : I18N.en[key];
    return typeof value === "function" ? value(...args) : value;
  };

  const panel = document.createElement("div");
  panel.id = "opl-panel";
  panel.className = "opl-tkgm";
  panel.innerHTML = `
    <div class="opl-head">
      <h1 data-i18n="title"></h1>
      <button id="opl-lang" class="opl-lang" type="button"></button>
    </div>
    <div class="opl-source" data-i18n="source"></div>
    <button id="opl-use-selected" class="opl-wide opl-secondary" type="button" data-i18n="useSelected"></button>
    <div id="opl-selected" class="opl-selected"></div>
    <div class="opl-fields">
      <label><span data-i18n="stallW"></span><input id="opl-sw" type="number" min="1.8" max="4" step="0.1" value="2.5"></label>
      <label><span data-i18n="stallD"></span><input id="opl-sd" type="number" min="3.5" max="9" step="0.1" value="5.0"></label>
      <label><span data-i18n="aisle"></span><input id="opl-aw" type="number" min="2.5" max="15" step="0.1" value="6.0"></label>
      <label><span data-i18n="angleStep"></span><input id="opl-as" type="number" min="1" max="45" step="1" value="10"></label>
    </div>
    <label class="opl-check"><input id="opl-btb" type="checkbox" checked> <span data-i18n="btb"></span></label>
    <label class="opl-check"><input id="opl-singlelane" type="checkbox"> <span data-i18n="oneway"></span></label>
    <label class="opl-check"><input id="opl-fillempty" type="checkbox"> <span data-i18n="fillEmpty"></span></label>
    <div class="opl-row">
      <button id="opl-compute" type="button" data-i18n="compute" disabled></button>
      <button id="opl-clear" class="opl-danger" type="button" data-i18n="clear"></button>
    </div>
    <div class="opl-result" id="opl-result" style="display:none"></div>
    <div class="opl-status" id="opl-status" role="status"></div>
  `;
  document.body.appendChild(panel);

  function enforcePanelVisibility() {
    panel.style.setProperty("position", "fixed", "important");
    panel.style.setProperty("top", "72px", "important");
    panel.style.setProperty("right", "12px", "important");
    panel.style.setProperty("left", "auto", "important");
    panel.style.setProperty("bottom", "auto", "important");
    panel.style.setProperty("z-index", "2147483647", "important");
    panel.style.setProperty("display", "block", "important");
    panel.style.setProperty("visibility", "visible", "important");
    panel.style.setProperty("opacity", "1", "important");
    panel.style.setProperty("margin", "0", "important");
    panel.style.setProperty("pointer-events", "auto", "important");
  }

  // TKGM harita kabını uygulama başladıktan sonra oluşturuyor. Paneli o anda
  // yeniden sona ve top layer'a almak, sonradan gelen map stacking context'ini
  // de aşar. Popover yoksa aynı işlem DOM sırası + maksimum z-index ile çalışır.
  function raisePanel() {
    enforcePanelVisibility();
    const canPopover = typeof panel.showPopover === "function" && typeof panel.hidePopover === "function";
    if (canPopover) {
      try {
        if (panel.matches(":popover-open")) panel.hidePopover();
        document.body.appendChild(panel);
        panel.setAttribute("popover", "manual");
        panel.showPopover();
        return;
      } catch (error) {
        panel.removeAttribute("popover");
      }
    }
    panel.removeAttribute("popover");
    document.body.appendChild(panel);
    enforcePanelVisibility();
  }
  raisePanel();

  let mapRaiseTimer = null;
  const mapObserver = new MutationObserver(function () {
    if (!document.querySelector("#map-canvas .leaflet-map-pane")) return;
    mapObserver.disconnect();
    clearTimeout(mapRaiseTimer);
    mapRaiseTimer = setTimeout(raisePanel, 0);
    setTimeout(raisePanel, 750);
  });
  mapObserver.observe(document.documentElement, { childList: true, subtree: true });
  for (const delay of [500, 1500, 3500, 7000]) setTimeout(raisePanel, delay);

  const toastElement = document.createElement("div");
  toastElement.id = "opl-toast";
  toastElement.setAttribute("popover", "manual");
  document.body.appendChild(toastElement);
  let toastTimer = null;
  function toast(message) {
    toastElement.textContent = message;
    if (typeof toastElement.showPopover === "function" && toastElement.hasAttribute("popover")) {
      try {
        if (!toastElement.matches(":popover-open")) toastElement.showPopover();
      } catch (error) {
        toastElement.removeAttribute("popover");
      }
    } else {
      toastElement.removeAttribute("popover");
    }
    toastElement.classList.add("opl-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastElement.classList.remove("opl-show");
      if (typeof toastElement.hidePopover === "function") {
        try {
          if (toastElement.matches(":popover-open")) toastElement.hidePopover();
        } catch (error) {}
      }
    }, 2800);
  }

  const $ = (selector) => panel.querySelector(selector);
  const selectedElement = $("#opl-selected");
  const statusElement = $("#opl-status");
  const resultElement = $("#opl-result");
  const computeButton = $("#opl-compute");
  const setStatus = (message) => { statusElement.textContent = message; };

  const INPUT_SPECS = [
    { selector: "#opl-sw", key: "stallWidthM", label: "stallW", min: 1.8, max: 4 },
    { selector: "#opl-sd", key: "stallDepthM", label: "stallD", min: 3.5, max: 9 },
    { selector: "#opl-aw", key: "aisleWidthM", label: "aisle", min: 2.5, max: 15 },
    { selector: "#opl-as", key: "angleStepDeg", label: "angleStep", min: 1, max: 45 },
  ];

  function readOptions() {
    const values = {};
    for (const spec of INPUT_SPECS) {
      const input = $(spec.selector);
      const value = Number(input.value);
      const valid = Number.isFinite(value) && value >= spec.min && value <= spec.max;
      const message = valid ? "" : t("invalidNumber", t(spec.label), spec.min, spec.max);
      input.setCustomValidity(message);
      if (!valid) {
        setStatus(message);
        toast(message);
        input.focus();
        return null;
      }
      values[spec.key] = value;
    }
    if ($("#opl-singlelane").checked) values.aisleWidthM = 3.5;
    values.backToBack = $("#opl-btb").checked;
    values.fillEmpty = $("#opl-fillempty").checked;
    values.gates = [];
    return values;
  }

  function postToPage(type, payload) {
    window.postMessage({ source: SOURCE, version: VERSION, direction: "TO_PAGE", type, payload: payload || null }, location.origin);
  }

  function parcelLabel(properties) {
    const ada = properties.adaNo;
    const parselNo = properties.parselNo;
    if (ada && parselNo) return `${ada}/${parselNo}`;
    if (parselNo) return String(parselNo);
    if (properties.ozet) return String(properties.ozet);
    return t("parcelFallback");
  }

  function updateSelectedText() {
    if (!parcel || !projection) {
      selectedElement.textContent = t("noSelection");
      computeButton.disabled = true;
      return;
    }
    selectedElement.textContent = t(
      "selected",
      parcelLabel(parcel.properties),
      parcel.ring.length,
      projection.areaM2.toFixed(0)
    );
    computeButton.disabled = false;
  }

  function geometryFailureMessage(code) {
    if (code === "MULTIPOLYGON_UNSUPPORTED") return t("multipolygon");
    if (code === "POLYGON_HOLES_UNSUPPORTED") return t("holes");
    if (code === "TOO_MANY_VERTICES") return t("tooMany");
    return t("badGeometry");
  }

  function acceptParcel(feature) {
    const normalized = geometryApi.normalizeParcelFeature(feature);
    if (!normalized.ok) {
      parcel = null;
      projection = null;
      result = null;
      resultElement.style.display = "none";
      postToPage("CLEAR_LAYOUT");
      updateSelectedText();
      const message = geometryFailureMessage(normalized.code);
      setStatus(message);
      toast(message);
      return;
    }
    const nextProjection = geometryApi.createLocalProjection(normalized.parcel.ring);
    if (!nextProjection) {
      parcel = null;
      projection = null;
      result = null;
      resultElement.style.display = "none";
      postToPage("CLEAR_LAYOUT");
      updateSelectedText();
      const message = t("badGeometry");
      setStatus(message);
      toast(message);
      return;
    }
    parcel = normalized.parcel;
    projection = nextProjection;
    result = null;
    resultElement.style.display = "none";
    postToPage("CLEAR_LAYOUT");
    updateSelectedText();
    setStatus(t("ready"));
  }

  function localizeWarning(warning) {
    if (!warning || !warning.code) return t("warningUnknown");
    if (warning.code === "DISCONNECTED_NETWORK_PRUNED") return t("warningDisconnected", warning.stalls || 0, warning.aisles || 0);
    if (warning.code === "OUTSIDE_POLYGON_PRUNED") return t("warningOutside", warning.stalls || 0, warning.aisles || 0);
    return t("warningUnknown");
  }

  function renderResult() {
    if (!result) return;
    const metadata = result.classification;
    const perCar = metadata.totalParking ? (result.areaM2 / metadata.totalParking).toFixed(1) : "—";
    const warning = result.warnings.map(localizeWarning).join(" ");
    resultElement.innerHTML = t(
      "result",
      metadata.totalParking,
      metadata.accessible,
      metadata.ev,
      result.angleDeg,
      result.laneM.toFixed(1),
      result.areaM2.toFixed(0),
      perCar,
      result.ms,
      warning
    );
    resultElement.style.display = "block";
  }

  function compute() {
    if (!parcel || !projection) {
      const message = t("noSelection");
      setStatus(message);
      toast(message);
      return;
    }
    const options = readOptions();
    if (!options) return;
    computeButton.disabled = true;
    const started = performance.now();
    let layout = null;
    try {
      layout = computeBestLayout(projection.polygon, 1, options);
    } catch (error) {
      layout = null;
    }
    const elapsed = (performance.now() - started).toFixed(0);
    computeButton.disabled = false;
    if (!layout) {
      result = null;
      resultElement.style.display = "none";
      postToPage("CLEAR_LAYOUT");
      setStatus(t("invalidArea"));
      toast(t("invalidArea"));
      return;
    }

    const classification = geometryApi.classifyStalls(layout.stalls, layout.angleDeg, 1, options);
    const featureCollection = geometryApi.buildLayoutFeatureCollection(parcel, projection, layout, classification);
    if (!featureCollection) {
      setStatus(t("renderFailed"));
      toast(t("renderFailed"));
      return;
    }
    const warnings = layout.metadata && Array.isArray(layout.metadata.warnings) ? layout.metadata.warnings : [];
    result = {
      angleDeg: layout.angleDeg,
      areaM2: layout.areaM2,
      laneM: options.aisleWidthM,
      ms: elapsed,
      classification: classification.metadata,
      warnings,
    };
    renderResult();
    postToPage("RENDER_LAYOUT", { featureCollection });
    const warningText = warnings.map(localizeWarning).join(" ");
    setStatus(`${t("computed")}${warningText ? ` ${warningText}` : ""}`);
  }

  function clearLayout() {
    result = null;
    resultElement.style.display = "none";
    postToPage("CLEAR_LAYOUT");
    setStatus(parcel ? t("cleared") : t("noSelection"));
  }

  function applyLanguage() {
    panel.querySelectorAll("[data-i18n]").forEach((element) => {
      element.textContent = t(element.getAttribute("data-i18n"));
    });
    $("#opl-lang").textContent = lang === "en" ? "TR" : "EN";
    updateSelectedText();
    if (result) renderResult();
  }

  function handleBridgeMessage(event) {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.source !== SOURCE || message.version !== VERSION ||
        message.direction !== "TO_EXTENSION" || typeof message.type !== "string") return;
    raisePanel();
    if (message.type !== "BRIDGE_ERROR") bridgeReady = true;
    if (message.type === "BRIDGE_READY") {
      postToPage("REQUEST_SELECTION");
    } else if (message.type === "PARCEL_SELECTED" && message.payload) {
      acceptParcel(message.payload.feature);
    } else if (message.type === "NO_SELECTION") {
      if (!parcel) setStatus(t("noSelection"));
    } else if (message.type === "SELECTION_CLEARED") {
      parcel = null;
      projection = null;
      result = null;
      resultElement.style.display = "none";
      updateSelectedText();
      setStatus(t("selectionCleared"));
    } else if (message.type === "BRIDGE_ERROR") {
      bridgeReady = false;
      setStatus(t("bridgeChanged"));
      toast(t("bridgeChanged"));
    } else if (message.type === "RENDER_ERROR") {
      setStatus(t("renderFailed"));
      toast(t("renderFailed"));
    }
  }
  window.addEventListener("message", handleBridgeMessage);

  $("#opl-lang").addEventListener("click", function () {
    lang = lang === "en" ? "tr" : "en";
    try { localStorage.setItem("opl-lang", lang); } catch (error) {}
    applyLanguage();
    setStatus(parcel ? t("ready") : bridgeReady ? t("noSelection") : t("waitingBridge"));
  });
  $("#opl-use-selected").addEventListener("click", function () {
    postToPage("REQUEST_SELECTION");
    if (!bridgeReady) setStatus(t("waitingBridge"));
  });
  computeButton.addEventListener("click", compute);
  $("#opl-clear").addEventListener("click", clearLayout);

  applyLanguage();
  setStatus(t("waitingBridge"));
  postToPage("REQUEST_SELECTION");
})();
