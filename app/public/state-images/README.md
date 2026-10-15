# Market-status tile image pools

Drop photos into these folders — that's the whole workflow. A Vite plugin
(`stateImagesManifest` in `vite.config.ts`) enumerates every image at
build/dev time and the market-status tile picks ONE at random per page load
from the pool matching the current market state + desk status. Refresh →
possibly a different image. Delete a file and it's out of the rotation.

**Files MUST have an image extension** (`.jpg`, `.jpeg`, `.png`, `.webp`,
`.avif`, `.gif`). Extensionless files are invisible to the manifest AND the
dev server won't serve them with an image content-type — five files had to
be renamed `.jpg` after the first drop.

## The curation loop

1. `npm run normalize:images` — backs up originals to `../originals-state-images/`
   (once per file), downscales anything wider than 1600px, re-encodes
   (JPEG q82 / WebP q80 / AVIF q60), strips metadata, and steers mean
   brightness toward ~95/255 with a clamped ±35% gain — subtle sameness,
   not a flattening. Safe to re-run; it converges rather than ratcheting.
2. `npm run review:images` → http://localhost:5177 — the propose→approve pass.
   Every image shows how the tile actually crops it (hero ~2:1 and /oracle
   ~3:2 previews) at its current focal point. **Click a preview to move the
   focal point** (the subject the cover-crop follows — dead space doesn't
   matter, the subject does). Approve marks it curated; Reject benches the
   file as `*.rejected` (ignored by the site, restorable from the page or
   by deleting the suffix). Everything writes `focal.json` live.
3. Rebuild the app — the manifest + focal points are bundled at build time
   (the dev server hot-reloads them).

## Pools

| Folder | Shows when |
|---|---|
| `0-open/default` | NYSE regular session (state 0). Desk never operates here. |
| `1-extended/desk-open` | Extended hours (state 1: premarket or after close) and the bond desk is live with lots remaining. |
| `1-extended/desk-wait` | Extended hours, desk NOT selling — discount gate not met, buyback floor at/above spot, or the 5-day warmup hasn't finished. |
| `1-extended/sold-out` | Extended hours, today's sheet posted but every lot is gone. |
| `2-closed/nite-bonus` | Market CLOSED (state 2) with offers still live — the late-nite window with the +0.5% bonus. The money shot; make these feel like a midnight flash sale. |
| `2-closed/desk-wait` | Market closed, no live offers (gate/floor/warmup). |
| `2-closed/sold-out` | Market closed, sheet sold out. The "you missed it" pool. |
| `3-halted/default` | Trading halted / circuit breaker (state 3). Rare — the alt-sheet window. |

An EMPTY pool falls back: substate pools fall back to the state's
`default/` if one exists, then to the built-in SVG art, then to the plain
tint gradient. So you can launch with just a few pools filled and add the
rest later — the tile never breaks.

## What the tile does to every photo (CSS, automatic)

- Focal-point cover crop (`background-position` from `focal.json`) so the
  subject stays framed at any viewport size.
- A flat dim + a state-COLORED vignette fading in from the borders/corners
  (open = green-edged, after-hours = amber, closed = slate, halted = red).
- A masked blur plate behind the title / subtitle / trading-day copy so
  text sits on a soft-focus island instead of sharp photo detail.

## Choosing images

**Target 1600 × 1000 px (16:10), JPEG ~80% quality or WebP, under ~300 KB each.**

Why those numbers:

- The tile renders at most ~720 CSS px wide (the /oracle full variant), so
  1600 px covers it at 2× retina with margin. Bigger is wasted bytes.
- 16:10 is the sweet spot between the homepage tile (~2:1, squat) and the
  /oracle tile (~3:2, taller) — `background: cover` crops whichever
  dimension overflows, and the edge shadow hides ~20% of each edge anyway,
  so anything from 3:2 to 2:1 works without visible loss.
- Only ONE image downloads per visitor (the randomly chosen one), so pool
  size costs repo weight, not page weight. 3–5 images per pool is enough
  for the refresh-lottery feel; sold-out and nite-bonus deserve the most.

Art direction:

- Prefer **already-dark, low-key images** — the normalizer will pull
  outliers toward the pack, but it can't rescue a sunny afternoon.
- **Center-weighted subjects** — the vignette eats the edges; anything you
  care about should live in the middle 60% (and set the focal on it).
- No text, no watermarks, nothing busy directly behind the title area.
- Keep the mood consistent WITHIN a pool (that's the joke: same vibe,
  different picture), but let pools differ deliberately — nite-bonus
  should feel conspicuously more alive than desk-wait.

