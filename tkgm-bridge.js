// tkgm-bridge.js — TKGM'nin MAIN world Leaflet durumuyla dar kapsamlı köprü.
(function () {
  "use strict";
  if (window.__oplTkgmBridgeLoaded) return;
  window.__oplTkgmBridgeLoaded = true;

  const SOURCE = "opl-tkgm-bridge";
  const VERSION = 1;
  const DIRECTION_TO_EXTENSION = "TO_EXTENSION";
  const DIRECTION_TO_PAGE = "TO_PAGE";
  const MAX_CAPTURED_COORDINATES = 1028;
  const MAX_RENDER_COORDINATES = 120000;
  const MAX_RENDER_POLYGONS = 22501;
  const ALLOWED_PROPERTIES = ["adaNo", "parselNo", "ozet", "zeminId", "parselId"];
  const ALLOWED_KINDS = new Set(["parcel", "aisle", "standard", "stall-lines", "accessible", "ev", "landscape"]);

  let channel = null;
  let constants = null;
  let Leaflet = null;
  let map = null;
  let selectedFeature = null;
  let selectedLayer = null;
  let overlayGroup = null;
  let renderer = null;
  let paneName = null;

  function post(type, payload) {
    window.postMessage({
      source: SOURCE,
      version: VERSION,
      direction: DIRECTION_TO_EXTENSION,
      type,
      payload: payload || null,
    }, location.origin);
  }

  function safePrimitive(value) {
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    const text = String(value).trim();
    return text ? text.slice(0, 120) : undefined;
  }

  function sanitizeRing(ring) {
    if (!Array.isArray(ring)) return [];
    const clean = [];
    for (const coordinate of ring.slice(0, MAX_CAPTURED_COORDINATES)) {
      if (!Array.isArray(coordinate) || coordinate.length < 2) continue;
      const lng = Number(coordinate[0]);
      const lat = Number(coordinate[1]);
      if (Number.isFinite(lng) && Number.isFinite(lat)) clean.push([lng, lat]);
    }
    return clean;
  }

  function sanitizeFeature(feature) {
    if (!feature || feature.type !== "Feature" || !feature.geometry) return null;
    const geometry = feature.geometry;
    let cleanGeometry;
    if (geometry.type === "Polygon" && Array.isArray(geometry.coordinates)) {
      // İkinci halkanın varlığı içerik betiğinde "holes unsupported" olarak
      // reddedilsin; gereksiz iç halka verisini taşımıyoruz.
      cleanGeometry = {
        type: "Polygon",
        coordinates: geometry.coordinates.slice(0, 2).map(sanitizeRing),
      };
    } else if (geometry.type === "MultiPolygon") {
      cleanGeometry = { type: "MultiPolygon", coordinates: [] };
    } else {
      cleanGeometry = { type: String(geometry.type || ""), coordinates: [] };
    }
    const properties = {};
    const sourceProperties = feature.properties && typeof feature.properties === "object" ? feature.properties : {};
    for (const key of ALLOWED_PROPERTIES) {
      const value = safePrimitive(sourceProperties[key]);
      if (value !== undefined) properties[key] = value;
    }
    return { type: "Feature", properties, geometry: cleanGeometry };
  }

  function clearOverlay() {
    if (overlayGroup && map) {
      try { map.removeLayer(overlayGroup); } catch (error) {}
    }
    overlayGroup = null;
  }

  function clearSelection(notify) {
    selectedFeature = null;
    selectedLayer = null;
    clearOverlay();
    if (notify) post("SELECTION_CLEARED");
  }

  function publishSelection() {
    if (!selectedFeature) {
      post("NO_SELECTION");
      return;
    }
    post("PARCEL_SELECTED", { feature: selectedFeature });
  }

  function selectFeature(feature, layer) {
    const clean = sanitizeFeature(feature);
    if (!clean) return;
    selectedFeature = clean;
    selectedLayer = layer || null;
    if (layer && layer._map) map = layer._map;
    if (layer && typeof layer.on === "function" && !layer.__oplTkgmSelectionHandlers) {
      layer.__oplTkgmSelectionHandlers = true;
      layer.on("click", function () {
        selectFeature(feature, layer);
      });
      layer.on("remove", function () {
        if (selectedLayer === layer) clearSelection(true);
      });
    }
    clearOverlay();
    publishSelection();
  }

  function inspectFeatureCollection(collection) {
    if (!collection || collection.type !== "FeatureCollection" || !Array.isArray(collection.features) ||
        collection.features.length < 1 || collection.features.length > 7) return false;
    let coordinates = 0;
    let polygons = 0;
    const walk = (value) => {
      if (!Array.isArray(value)) return false;
      if (value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
        coordinates++;
        return coordinates <= MAX_RENDER_COORDINATES && value[0] >= -180 && value[0] <= 180 &&
          value[1] >= -90 && value[1] <= 90;
      }
      for (const child of value) if (!walk(child)) return false;
      return true;
    };
    for (const item of collection.features) {
      if (!item || item.type !== "Feature" || !item.geometry || !item.properties ||
          !ALLOWED_KINDS.has(item.properties.kind)) return false;
      const type = item.geometry.type;
      if (type === "Polygon") polygons += 1;
      else if (type === "MultiPolygon") polygons += Array.isArray(item.geometry.coordinates) ? item.geometry.coordinates.length : 0;
      else if (type !== "MultiPoint" && type !== "MultiLineString") return false;
      if (polygons > MAX_RENDER_POLYGONS || !walk(item.geometry.coordinates)) return false;
    }
    return true;
  }

  function styleFor(feature) {
    const common = {
      pane: paneName,
      renderer,
      interactive: false,
      smoothFactor: 0,
      lineCap: "butt",
      lineJoin: "miter",
    };
    switch (feature.properties.kind) {
      case "parcel": return Object.assign(common, { color: "#facc15", weight: 2.5, fillColor: "#4b5563", fillOpacity: 0.62 });
      case "aisle": return Object.assign(common, { color: "#d1d5db", weight: 0.8, fillColor: "#737b85", fillOpacity: 0.9 });
      case "stall-lines": return Object.assign(common, { color: "#ffffff", weight: 1, fill: false });
      case "accessible": return Object.assign(common, { stroke: false, weight: 0, fill: true, fillColor: "#2563eb", fillOpacity: 0.82 });
      case "ev": return Object.assign(common, { stroke: false, weight: 0, fill: true, fillColor: "#22c55e", fillOpacity: 0.78 });
      case "landscape": return Object.assign(common, { color: "#14532d", weight: 1, fill: true, fillColor: "#22c55e", fillOpacity: 0.95 });
      default: return Object.assign(common, { color: "#ffffff", weight: 1, fillOpacity: 0 });
    }
  }

  function ensurePane() {
    if (!map) return false;
    paneName = "opl-tkgm-layout";
    let pane = map.getPane && map.getPane(paneName);
    if (!pane && map.createPane) pane = map.createPane(paneName);
    if (!pane) return false;
    pane.style.zIndex = "610";
    pane.style.pointerEvents = "none";
    if (!renderer) renderer = Leaflet.canvas({ pane: paneName, padding: 0.5 });
    return true;
  }

  function renderLayout(collection) {
    if (!map || !Leaflet || !inspectFeatureCollection(collection) || !ensurePane()) {
      post("RENDER_ERROR", { code: map ? "INVALID_LAYOUT" : "MAP_UNAVAILABLE" });
      return;
    }
    clearOverlay();
    try {
      overlayGroup = Leaflet.layerGroup().addTo(map);
      Leaflet.geoJSON(collection, {
        pane: paneName,
        renderer,
        interactive: false,
        smoothFactor: 0,
        lineCap: "butt",
        lineJoin: "miter",
        style: styleFor,
        pointToLayer: function (feature, latlng) {
          return Leaflet.circleMarker(latlng, {
            pane: paneName,
            renderer,
            interactive: false,
            radius: 4.5,
            color: "#14532d",
            weight: 1,
            fillColor: "#22c55e",
            fillOpacity: 0.95,
          });
        },
      }).addTo(overlayGroup);
      post("RENDERED");
    } catch (error) {
      clearOverlay();
      post("RENDER_ERROR", { code: "LEAFLET_RENDER_FAILED" });
    }
  }

  function handlePageMessage(event) {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.source !== SOURCE || message.version !== VERSION ||
        message.direction !== DIRECTION_TO_PAGE || typeof message.type !== "string") return;
    if (message.type === "REQUEST_SELECTION") publishSelection();
    else if (message.type === "CLEAR_LAYOUT") clearOverlay();
    else if (message.type === "RENDER_LAYOUT") renderLayout(message.payload && message.payload.featureCollection);
  }
  window.addEventListener("message", handlePageMessage);

  function installBridge(loadedChannel, loadedConstants, loadedLeaflet) {
    channel = loadedChannel;
    constants = loadedConstants;
    Leaflet = loadedLeaflet;
    if (!channel || !constants || !constants.requestNames || !Leaflet || typeof channel.request !== "function") {
      post("BRIDGE_ERROR", { code: "TKGM_MODULES_UNAVAILABLE" });
      return;
    }
    const drawName = constants.requestNames.drawParcelEntity;
    const clearName = constants.requestNames.clearMap;
    if (!drawName || !clearName) {
      post("BRIDGE_ERROR", { code: "TKGM_INTERFACE_CHANGED" });
      return;
    }
    const originalRequest = channel.request;
    channel.request = function () {
      const name = arguments[0];
      const result = originalRequest.apply(this, arguments);
      try {
        if (name === drawName) selectFeature(arguments[1], result);
        else if (name === clearName) clearSelection(true);
      } catch (error) {
        post("BRIDGE_ERROR", { code: "PARCEL_CAPTURE_FAILED" });
      }
      return result;
    };
    post("BRIDGE_READY");
  }

  let attempts = 0;
  const timer = window.setInterval(function () {
    attempts++;
    const requireFn = window.requirejs || window.require;
    const configured = requireFn && requireFn.s && requireFn.s.contexts && requireFn.s.contexts._ &&
      requireFn.s.contexts._.config && requireFn.s.contexts._.config.baseUrl;
    if (typeof requireFn !== "function" || !configured) {
      if (attempts >= 200) {
        window.clearInterval(timer);
        post("BRIDGE_ERROR", { code: "TKGM_REQUIREJS_UNAVAILABLE" });
      }
      return;
    }
    window.clearInterval(timer);
    try {
      requireFn(["util/channel", "util/constants", "leaflet"], installBridge, function () {
        post("BRIDGE_ERROR", { code: "TKGM_MODULE_LOAD_FAILED" });
      });
    } catch (error) {
      post("BRIDGE_ERROR", { code: "TKGM_MODULE_LOAD_FAILED" });
    }
  }, 100);
})();
