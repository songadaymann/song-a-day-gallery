# Song-A-Day Gallery – Modernisation Roadmap

This document tracks the incremental refactor that brings our viewer up to par with reference explorers such as [shazoo.xyz/chromie-squiggle](https://shazoo.xyz/chromie-squiggle) and [shazoo.xyz/cryptopunks](https://shazoo.xyz/cryptopunks).

---
## Inspiration – What we are copying

| Feature / Behaviour | Shazoo Reference | Our Implementation Goal |
|---------------------|------------------|-------------------------|
| Tight pan bounds + inertia | Chromie-Squiggle viewer feels "springy" and never shows background | Match `constrainDuringPan`, `springStiffness`, custom bounds guard |
| Control bar (zoom ±, home, search, filter, GIF toggle) | Top-right icon bar | Material Icons row in fixed header |
| Global search | Address bar on shazoo filters tokens live | Lunr.js index → fly-out dropdown |
| Attribute filter drawer | Squiggle trait filter | Polished slide-out drawer, multi-select chips |
| Home icon / branding | Small coloured logo | SVG logo that calls `viewer.goHome()` |

---
## Phase Checklist

### Phase A ✔ – Code extraction & build system (completed)
* Moved the **~500 LOC** inline script into `src/gallery.js` (self-contained module).
* Added **Vite** tooling (`npm run dev / build / preview`).
* Disabled legacy inline script to avoid double execution.

### Phase B – Viewer bounds & control bar (next)
1. Tune OpenSeaDragon options for pan bounds & momentum.
2. Build reusable `src/ui/createButton()` helper.
3. Insert Material-Icon buttons: **zoom+ / zoom- / home / GIF toggle / filter toggle**.
4. Optional: hide buttons while user drags (same as shazoo).

### Phase C – Global search
1. Generate a **Lunr** index at build-time (`data/search_index.json`).
2. Top-bar search input with debounced lookup & dropdown.
3. Selecting a hit zooms to the token.

### Phase D – Filter drawer polish
1. Replace per-song DOM overlays with single `<canvas>` mask.
2. Add "Clear All" and active-chip list.
3. Improve mobile layout.

### Phase E – Finishing touches
* Accessibility & performance audit.
* README update & code comments cleanup.
* Cut a `v1.0` release.

---
## Local development

```bash
# 1. one-time setup
npm install

# 2. dev server (auto reload)
npm run dev

# 3. production build
npm run build   # outputs to /dist
```

---
*Document updated: $(date).* 