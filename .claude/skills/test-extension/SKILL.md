---
name: test-extension
description: Verifying a change — what `npm test` covers and what only a browser can, plus how to exercise the filter across its three runtime contexts (page, service worker, offscreen document). Use when asked to test, verify, or reproduce a bug.
---

# Testing

## What the test suite covers

`npm test` (`scripts/test.mjs`, no framework, bare Node) exercises the **pure logic** in `src/shared/`: keyword compilation and matching, `riskScore`, the allowlist, hostname parsing, and settings migration. `npm run check` runs it after the manifest/asset/syntax check, so `npm run check` is the single gate before a commit.

A change to `src/shared/keywords.js` or `settings.js` should come with an assertion in `scripts/test.mjs` — that layer is where a subtle mistake silently hides innocent images.

Everything else — the state machine, observers, messaging, the offscreen document, CSS — needs a real browser. It has no automated coverage, so the walkthrough below is not optional for those paths.

## In the browser

Build first (`npm run check && npm run build`), then `chrome://extensions` → Developer mode → **Load unpacked**.

## Three consoles, three contexts

A bug is usually in one of them, and each has its own DevTools:

| Context | Where to open it | What lives there |
| --- | --- | --- |
| Page / frame | DevTools on the page itself | `dist/content.js` — the state machine, observers, canvas snapshots |
| Service worker | `chrome://extensions` → the extension → **service worker** link | scoring queue, LRU cache, badge, pre-blur registration |
| Offscreen document | `chrome://extensions` → **Inspect views: offscreen.html** (only while it exists) | TensorFlow, the model, image fetch/decode |

The offscreen link disappears when the document is closed — after 5 idle minutes, or when it has never been created. Trigger an image score and it reappears.

## Inspecting a page's verdicts

Every element the filter has looked at carries `data-imgfilter` with one of `pending`, `safe`, `blocked`, `revealed`. CSS backgrounds use `data-imgfilter-bg`.

```js
// verdict histogram for this frame
[...document.querySelectorAll('[data-imgfilter]')]
  .reduce((acc, el) => (acc[el.getAttribute('data-imgfilter')] = (acc[el.getAttribute('data-imgfilter')] ?? 0) + 1, acc), {})

// what is currently hidden
document.querySelectorAll('[data-imgfilter="blocked"]').length

// is the frame filtering at all?  present = filter is off / allowlisted here
document.documentElement.hasAttribute('data-imgfilter-off')
```

An element with **no** `data-imgfilter` attribute was never evaluated — that is a scanning problem (shadow DOM, not an `img`/`video`, never added to the DOM). An element stuck on `pending` never reached the viewport, never finished loading, or the score never came back — a different problem entirely. Distinguish the two before debugging.

## Paths worth walking

| Path | How to reach it | What "correct" looks like |
| --- | --- | --- |
| Keyword hit | `alt`/`title`/`aria-label`/`src`/wrapping `<a href>` containing a keyword | Hidden immediately, no model round-trip, no viewport wait |
| Word-boundary correctness | A page with `essexyachts`, `middlesex`, `adulterated` | **Not** hidden. v1 substring matching hid these; the regex uses letter boundaries |
| Model hit, URL path | A real photo the extension can fetch | Blurs shortly after scrolling into view (400 px before it enters, actually) |
| Model hit, pixel path | A `blob:` image, or one that needs page credentials | Content script snapshots to a 224 px canvas and resends; still blurs |
| Tainted canvas | Cross-origin image, no CORS, not fetchable by the extension | **Stays visible.** Failing open is intended — verify it does not blur the world |
| Pre-blur | "הסתרה עד לבדיקה" on, hard-reload a heavy page | Everything blurred from first paint, clearing progressively as verdicts land |
| Allowlist | Add the host from the popup | Frame goes inert, `data-imgfilter-off` appears, previously hidden images restored with their original `title`/`aria-label` |
| Click to reveal | Click a blurred image | Reveals it, and the click does **not** reach the page (no navigation) |
| Reveal all | Popup → "חשיפת כל התמונות בדף" | Every frame in the tab reveals, popup closes |
| Badge | Any page with hidden images | Per-tab count; resets on navigation |
| Frames | A page with a cross-origin iframe of images | Filtered too (`all_frames: true`), and the badge sums across frames |
| SPA swap | A feed that swaps `src` on scroll | Re-evaluated (the observer watches `src`/`srcset`/`poster`/`alt`/`title`) |
| Settings churn | Move the threshold slider with a page open | Every verdict is discarded and recomputed live, no reload |
| Non-filterable page | `chrome://extensions`, the Web Store | Popup says "לא ניתן לסנן את הדף הזה"; no errors in the worker console |

## Worth deliberately breaking

- **Kill the service worker** (`chrome://extensions` → the worker's "terminate"/inspect close) mid-scroll. Scoring must recover: the content script fails open rather than leaving images blurred forever. The badge count is expected to be lost — it lives in worker memory.
- **Wait out the idle shutdown** (5 minutes with no scoring), then load an image-heavy page. The offscreen document is recreated and the model reloads; the first image is slow, nothing hangs.

## Reporting

Say what you actually observed, per path, including the ones you could not reach. "Tested" for a path you never triggered in a real browser is a false report — name the ones you skipped and why.
