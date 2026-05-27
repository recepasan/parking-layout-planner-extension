# Parking Layout Planner

A browser extension (Chrome/Edge, Manifest V3) that overlays on **Google Maps**, lets you draw a parcel, and generates an efficient surface **parking layout at real metric scale** — stalls, drive aisles, gates and landscape islands — rendered like a site plan.

> ⚠️ **Experimental / educational.** This is an unofficial overlay tool. It draws only on the boundary **you** draw; it does not scrape, store, or derive products from Google's imagery. Use it in line with the [Google Maps Platform Terms](https://cloud.google.com/maps-platform/terms). Results are approximate planning estimates, not engineering drawings.

<!-- Add a screenshot at docs/screenshot.png and uncomment:
![Screenshot](docs/screenshot.png)
-->

## Features

- **Draw any parcel** — click vertices (straight edges) or **freehand drag** for oval/curved boundaries.
- **Real metric scale** — derived from the map zoom via Web Mercator (`156543.03 · cos(lat) / 2^zoom` m/px).
- **Zoom-independent** — the layout is computed in a fixed reference scale, so you get the **same result at any zoom level**.
- **Geo-anchored** — the layout stays pinned to the ground when you pan/zoom and across map ↔ satellite (2D).
- **Smart layout engine** — searches orientations and phases, then does **regional decomposition** so thin strips and concave/L-shaped areas get filled instead of left empty. Every stall opens onto a connected drive aisle.
- **Editable roads** — add a **bendable** road, move/resize a road, or delete one; stalls re-flow around your roads.
- **Gates** — mark entry/exit points; accessible stalls cluster near the entrance, and an access lane is drawn from each gate.
- **Site-plan rendering** — asphalt, thin white "comb" stall lines, one-way flow arrows, lane dimension labels, accessible (blue), EV (green) and landscape-island markers.
- **Bilingual UI (English / Turkish)** with a one-click toggle; defaults to English and remembers your choice.

## Install (unpacked)

1. Open `chrome://extensions` in Chrome or Edge.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.
4. **Important:** open the extension's **Details** and turn on **"Allow access to search page results"**. Because the content script matches `google.com`, Chrome gates it behind this toggle — **without it the panel will not appear.**
5. Open `https://www.google.com/maps` and **reload the tab** — the panel appears top-right.

No build step, no dependencies — plain JavaScript.

### Panel not showing?

- Confirm **"Allow access to search page results"** is enabled (step 4), then **reload the Maps tab**.
- The content script only injects on `https://www.google.com/maps…`. If you loaded the extension while Maps was already open, reload the tab.
- Open DevTools → Console; you should see `[Parking Layout] content script loaded`.

## Usage

1. Zoom to your site in **top-down (2D)** view.
2. Draw the area:
   - **Vertices** — click corners; return to the start / double-click / Enter to close.
   - **Freehand** — hold and drag; release to close (oval/curved boundaries).
3. *(Optional)* set **Entry Gate** / **Exit Gate** on the boundary.
4. *(Optional)* adjust stall size, aisle width, angle step; toggle **Back-to-back double**, **One-way lane (3.5 m)**, or **Fill empty areas**.
5. **Compute Layout** — capacity, orientation and efficiency are shown.
6. *(Optional)* edit roads:
   - **Add Road** — click points for a bendable road, finish, then **Compute** to fill stalls along it.
   - **Move Road** — drag a road or its yellow handles; **Compute** re-flows stalls.
   - **Delete Road** — remove a drive aisle.

### Options

| Option | Effect |
| --- | --- |
| Stall width / depth (m) | Bay dimensions (default 2.5 × 5.0 m). |
| Aisle (m) | Drive-lane width (default 6.0 m). |
| Angle step (°) | Orientation search granularity (smaller = finer/slower). |
| Back-to-back double | Two rows share each aisle (double-loaded modules). |
| One-way lane (3.5 m) | Narrower one-way drive lanes. |
| Fill empty areas | Pack leftover regions (≥ one module wide) with extra rows. Off by default. |

## How it works

- Geometry is stored as latitude/longitude and re-projected each frame, so the overlay is **geo-anchored**.
- The layout engine (`layout.js`) works in a fixed metric frame and:
  1. tries each orientation + row phase, splitting every aisle row into all maximal segments that fit the polygon (handles concavity), then links them with minimal cross-aisles (union-find spanning);
  2. also computes a **regional decomposition** (largest-rectangle partition, each region laid out with its own orientation/phase) and keeps whichever yields more stalls;
  3. optionally fills remaining empty rectangles;
  4. adds perimeter stalls only where they directly abut an aisle.
- `content.js` handles the Google Maps overlay, drawing tools, projection, i18n and rendering.

## Limitations

- Strips narrower than ~one module (stall + aisle ≈ 11 m) stay empty — there is no room for both a car and its access lane.
- 3D/tilted map view can't be aligned with a flat projection; alignment pauses and resumes when you return to 2D.
- The parcel center is assumed at the viewport center; if a Google side panel is open the projection may shift slightly — use the plain map view.
- Obstacles inside the parcel (buildings, trees) are not detected; the algorithm fills geometrically.

## License

[MIT](LICENSE).

---

## Türkçe

Google Maps üzerinde bir parsel çizip **gerçek metre ölçeğinde** verimli bir otopark yerleşimi üreten deneysel bir tarayıcı eklentisi. Arayüz **İngilizce/Türkçe** (sağ üstteki düğmeyle değiştirilir, varsayılan İngilizce).

**Kurulum:**
1. `chrome://extensions` → **Geliştirici modu**'nu aç.
2. **Paketlenmemiş öğe yükle** → bu klasörü seç.
3. **Önemli:** eklentinin **Ayrıntılar**'ını açıp **"Arama sayfası sonuçlarına erişime izin ver"** seçeneğini etkinleştir. İçerik betiği `google.com` ile eşleştiği için Chrome bunu bu seçeneğe bağlar — **işaretlenmezse panel açılmaz.**
4. `google.com/maps`'i aç ve sekmeyi **yenile** → panel sağ üstte çıkar.

**Kullanım:** alanı çiz (**Vertices**/**Freehand**) → *(isteğe bağlı)* kapı/yol/seçenekler → **Compute Layout**.

**Panel görünmüyorsa:** "Arama sayfası sonuçlarına erişime izin ver" açık mı kontrol et ve Maps sekmesini yenile.
