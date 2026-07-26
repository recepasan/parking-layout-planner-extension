# Parking Layout Planner

A dependency-free Chrome/Edge Manifest V3 extension that generates efficient surface **parking layouts at real metric scale**. Draw an area on **Google Maps**, or use the parcel currently selected on **TKGM Parsel Sorgu**; stalls, drive aisles and estimated markings are rendered as a geo-anchored site-plan overlay.

> ⚠️ **Experimental / educational.** This is an unofficial planning overlay, not an engineering or regulatory-compliance drawing. On Google Maps it uses only the boundary you draw. On TKGM it locally consumes only the parcel geometry the official page has already loaded after your explicit selection. It does not bulk-query, scrape, cache, or send parcel data to a backend or third party. Follow the applicable platform terms and verify TKGM permission/conditions before public or commercial distribution.

<!-- Add a screenshot at docs/screenshot.png and uncomment:
![Screenshot](docs/screenshot.png)
-->

## Features

- **Two map adapters** — draw any area on Google Maps, or use the latest selected/clicked parcel on TKGM Parsel Sorgu.
- **Real metric scale** — Google uses a fixed Web Mercator reference scale; TKGM uses a local WGS84 tangent-plane projection with metres as engine units.
- **Zoom-independent and geo-anchored** — results do not change with map zoom and stay pinned while panning/zooming.
- **Smart layout engine** — searches orientations and phases, handles concavity with regional decomposition, and prunes disconnected aisle components.
- **Google editing tools** — vertex/freehand drawing, entry/exit gates, and add/move/delete road tools.
- **TKGM-native rendering** — the computed result is converted back to EPSG:4326 and drawn in a separate non-interactive Leaflet layer.
- **Site-plan rendering** — aisles, stalls, accessible (blue), EV (green), and landscape-island markers. Accessible/EV counts are estimated markings within total capacity, not additional spaces or a compliance determination.
- **Bilingual UI (English / Turkish)** with a remembered one-click toggle.

## Install (unpacked)

1. Open `chrome://extensions` in Chrome or Edge.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.
4. **Important:** open the extension's **Details** and turn on **"Allow access to search page results"**. Because the content script matches `google.com`, Chrome gates it behind this toggle — **without it the panel will not appear.**
5. Open `https://www.google.com/maps` or `https://parselsorgu.tkgm.gov.tr/` and **reload the tab** — the panel appears top-right.

No build step, no dependencies — plain JavaScript.

### Tests

Run the dependency-free regression suite with Node.js:

```sh
node --check layout.js
node --check content.js
node --check tkgm-geometry.js
node --check tkgm-bridge.js
node --check tkgm-content.js
node --test test/*.test.js
```

The suite covers the layout engine plus TKGM Polygon validation, hole/MultiPolygon rejection, local metric projection, round-trip coordinate conversion, property filtering and output GeoJSON construction.

### Panel not showing?

- After loading or updating the unpacked extension, reload the already-open map tab.
- For Google Maps, confirm **"Allow access to search page results"** is enabled.
- For TKGM, use exactly `https://parselsorgu.tkgm.gov.tr/`, accept TKGM's own terms if prompted, then reload and select/click a parcel again.
- Open DevTools → Console; the adapters log `[Parking Layout] content script loaded` or `[Parking Layout] TKGM content script loaded`.

## Usage

### Google Maps

1. Zoom to your site in **top-down (2D)** view.
2. Draw the area:
   - **Vertices** — click corners; return to the start / double-click / Enter to close.
   - **Freehand** — hold and drag; release to close (oval/curved boundaries).
3. *(Optional)* set **Entry Gate** / **Exit Gate** on the boundary.
4. *(Optional)* adjust options or edit roads.
5. **Compute Layout**.

### TKGM Parsel Sorgu

1. Open TKGM Parsel Sorgu and select/query a parcel through the official interface.
2. If several parcel outlines are visible, click the parcel you want; the extension uses the most recently drawn/clicked parcel.
3. Click **Use Selected Parcel / Seçili Parseli Kullan** if the panel has not updated automatically.
4. Adjust the dimensions/options and click **Compute Layout / Yerleşimi Hesapla**.
5. The extension computes locally and adds a separate, non-interactive Leaflet overlay. **Clear Layout** removes only this overlay.

TKGM v1 deliberately accepts only one simple `Polygon` exterior ring. `MultiPolygon` and polygons with interior holes are rejected instead of being silently simplified. The adapter does not call `cbsapi.tkgm.gov.tr`, enumerate parcels, read authentication/storage data, or transmit geometry elsewhere. It depends on TKGM's internal minified UI modules, so a TKGM update may require an extension update.

### Options

| Option | Effect |
| --- | --- |
| Stall width / depth (m) | Bay dimensions (default 2.5 × 5.0 m; UI ranges 1.8–4.0 × 3.5–9.0 m). |
| Aisle (m) | Drive-lane width (default 6.0 m; UI range 2.5–15.0 m). |
| Angle step (°) | Orientation search granularity, 1–45° (smaller = finer/slower). |
| Back-to-back double | Two rows share each aisle (double-loaded modules). |
| One-way lane (3.5 m) | Narrower one-way drive lanes. |
| Fill empty areas | Pack leftover regions (≥ one module wide) with extra rows. Off by default. |

## How it works

- Geometry is stored as latitude/longitude and re-projected each frame, so the overlay is **geo-anchored**.
- The layout engine (`layout.js`) works in a fixed metric frame and:
  1. tries each orientation + row phase, splitting every aisle row into all maximal segments that fit the polygon (handles concavity), then links them with minimal cross-aisles (union-find spanning);
  2. also computes a **regional decomposition** (largest-rectangle partition, each region laid out with its own orientation/phase) and keeps whichever yields more stalls;
  3. optionally fills remaining empty rectangles;
  4. adds perimeter stalls only where they directly abut an aisle;
  5. verifies the aisle graph and retains the entry-gate component (or, without an entry, the component serving the most stalls), reporting a localized warning when disconnected components are pruned.
- `content.js` handles the Google Maps overlay, drawing tools, projection, i18n and rendering.
- `tkgm-bridge.js` runs in the page's MAIN world, observes only TKGM's own `map:drawParcelEntity` flow, and draws validated output in a separate Leaflet layer. `tkgm-content.js` validates the narrow message payload and runs the shared engine in the isolated extension world.

## Safety limits and limitations

- Numeric UI inputs are finite and range-checked before computation: stall width 1.8–4.0 m, depth 3.5–9.0 m, aisle 2.5–15.0 m and angle step 1–45°. Invalid values stop computation with an English/Turkish message.
- The engine has a bounded input/work budget (up to 512 polygon vertices, 300,000 decomposition cells, 2,500 aisles, 20,000 stalls and 2,500,000 guarded work units). Over-budget or invalid/self-intersecting parcels are rejected instead of running unbounded.
- TKGM messages are versioned and schema/range checked. Only geometry plus a small parcel-identifier property allowlist crosses from the page world; arbitrary properties, tokens, identity/storage data and full API responses are discarded.
- TKGM selection capture relies on internal RequireJS/Backbone Radio names. A future TKGM release can break the adapter; it fails with an explicit interface-changed message rather than calling an undocumented endpoint or guessing geometry.
- Strips narrower than ~one module (stall + aisle ≈ 11 m) stay empty — there is no room for both a car and its access lane.
- 3D/tilted map view can't be aligned with a flat projection; alignment pauses and resumes when you return to 2D.
- The parcel center is assumed at the viewport center; if a Google side panel is open the projection may shift slightly — use the plain map view.
- Obstacles inside the parcel (buildings, trees) are not detected; the algorithm fills geometrically.

## License

[MIT](LICENSE).

---

## Türkçe

Google Maps üzerinde çizilen bir alanı veya **TKGM Parsel Sorgu'da seçilen parseli** kullanıp gerçek metre ölçeğinde deneysel otopark yerleşimi üretir. Arayüz İngilizce/Türkçe'dir.

**Kurulum:**
1. `chrome://extensions` → **Geliştirici modu**'nu aç.
2. **Paketlenmemiş öğe yükle** → bu klasörü seç.
3. Google Maps için eklentinin **Ayrıntılar** bölümündeki **"Arama sayfası sonuçlarına erişime izin ver"** seçeneğini etkinleştir.
4. `https://www.google.com/maps` veya `https://parselsorgu.tkgm.gov.tr/` sekmesini yenile.

**Google Maps:** alanı çiz → isteğe bağlı kapı/yol/seçenekler → **Yerleşimi Hesapla**.

**TKGM:** resmi arayüzden parseli sorgula/seç → gerekirse **Seçili Parseli Kullan** → seçenekleri ayarla → **Yerleşimi Hesapla**. Birden fazla parsel görünüyorsa kullanmak istediğin parsele tıkla. Hesaplama yereldir; eklenti CBS API'sine doğrudan istek atmaz, toplu sorgu yapmaz ve geometriyi başka yere göndermez. İlk sürüm yalnız iç boşluğu olmayan tek `Polygon` kabul eder.

**Notlar:** Sayısal girdiler doğrulanır ve motorun iş bütçesi sınırlıdır. Erişilebilir/EV adetleri toplam kapasiteye ek değildir; toplam içindeki tahmini işaretli yerlerdir. TKGM'nin dahili arayüzü değişirse adaptör güncelleme gerektirebilir. Kamusal/ticari dağıtım öncesinde TKGM kullanım şartlarını ve gerekli izinleri doğrulayın.

**Panel görünmüyorsa:** eklentiyi yükledikten/güncelledikten sonra açık harita sekmesini yenileyin. TKGM'de parseli yeniden seçin; Google Maps'te arama sonuçlarına erişim iznini kontrol edin.
