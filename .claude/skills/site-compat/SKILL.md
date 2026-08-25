---
name: site-compat
description: What the filter can and cannot see on a real page — the DOM surfaces it covers, the ones it structurally misses, and how sites break it. Use when an image is not being filtered on a specific site, when asked to extend coverage to a new kind of image, or when triaging a "it doesn't work on X" report.
---

# Site compatibility

## What is covered today

`scan()` walks `img, video` and evaluates each one.

| Surface | Covered | How |
| --- | --- | --- |
| `<img>` | yes | directly |
| `<picture>` / `srcset` | yes | `currentSrc` is the resolved source, and `srcset` is in the observed attribute list |
| `<video>` poster | yes | `sourceOf()` returns `element.poster`; video **frames** are not inspected |
| Lazy-loaded images | yes | a one-shot `load`/`loadedmetadata`/`error` listener re-evaluates |
| SPA source swaps | yes | `MutationObserver` with `attributeFilter: ["src","srcset","poster","alt","title"]`, and `evaluate()` short-circuits unless the effective source really changed |
| `blob:` / `data:` URLs | yes | routed straight to the canvas-snapshot path |
| Iframes, including `about:blank` | yes | `all_frames: true`, `match_about_blank: true` — each frame filters and reports its own count |
| CSS `background-image` | partly | keyword matching only, opt-in via `scanBackgrounds`, and only on elements present at scan time |

## What is structurally missed

These are not bugs to fix casually — each needs a real design decision:

- **Shadow DOM.** `querySelectorAll` does not pierce shadow roots and `MutationObserver` does not observe inside them. Images in web components are invisible to the filter. Covering them means walking `shadowRoot`s on every scan and attaching an observer per root (open roots only — closed ones are unreachable by design).
- **`<canvas>` pixels.** Anything drawn to a canvas, including images a page decodes itself.
- **SVG `<image>`.** An `SVGImageElement` does not match `img`.
- **`<object>` / `<embed>`.** Never inspected.
- **Video content.** Only the poster frame is considered.
- **CSS backgrounds by content.** The background pass is keyword-only — it never scores pixels — and it skips elements that appear after the debounced scan unless another scan is triggered. `image-set()` and pseudo-element backgrounds are not read at all.
- **Pages the extension cannot run on.** `chrome://`, the Web Store, other extensions, `view-source:`, the PDF viewer.

When a report says "it doesn't work on site X", determine which row above applies **before** touching the scoring code. The fast check is in the `test-extension` skill: an element with no `data-imgfilter` attribute was never seen (a scanning problem); one stuck on `pending` was seen but never resolved (a loading, viewport, or messaging problem).

## How sites break it

- **Overridden styling.** The blur is `!important` in `content.css`, so a page's own `filter` cannot beat it — but a page that wraps images in a container with its own `filter` or `backdrop-filter` can visually swamp it, and a page that replaces the element wholesale gets re-evaluated from scratch.
- **Attribute stomping.** Pages that rewrite `title`/`aria-label` on their images will overwrite the filter's label; `originalLabels` still restores what was there when the filter first touched it, which may be older than what the page expects. Rare, and preferable to destroying the page's own labels.
- **Cloned nodes.** `records` and `originalLabels` are `WeakMap`s keyed by element. A cloned node is a new element with the page's original attributes and no record — it gets evaluated fresh, which is correct.
- **Aggressive CSP.** Irrelevant to the content script itself (isolated world, injected by the browser), but a page's CSP can block the images it references, which surfaces as `error` → `allow()` on a broken image.
- **Credentialed image CDNs.** The offscreen fetch uses `credentials: "omit"`, so an image that requires cookies returns 401/403 → cached as a miss → the next sighting goes to the canvas path. That is the designed fallback, not a failure.
- **Very large images.** The offscreen fetch rejects blobs over 12 MB and gives up after 10 s — both fail open.

## Extending coverage

Any new surface has to answer three questions before it is worth adding: how is it *found* (a selector, a traversal, a computed style), how are its *pixels* obtained (a fetchable URL, a canvas draw, or nothing), and how is a verdict *applied* (an attribute the CSS already styles, or something new). A surface with no pixel path can only ever be keyword-filtered — which is exactly why the CSS background pass is keyword-only.

Cost is the constraint. `scanBackgrounds` iterates `document.querySelectorAll("*")` and calls `getComputedStyle` on each — that is why it is debounced, deferred to `requestIdleCallback`, and off by default. Shadow-DOM traversal would carry a similar cost profile and deserves the same treatment: opt-in, idle, debounced.
