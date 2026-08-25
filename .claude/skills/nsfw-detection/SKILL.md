---
name: nsfw-detection
description: How this extension decides an image is suspicious — the keyword pass, the nsfwjs model pass, thresholds, and the failure modes of each. Use when changing keywords, sensitivity, thresholds, what counts as a hit, how images are hidden, or when tuning false positives/negatives.
---

# The detection pipeline

Split across three contexts. [src/content/index.js](../../../src/content/index.js) decides *what* to check, [src/background/index.js](../../../src/background/index.js) caches and schedules, [src/offscreen/index.js](../../../src/offscreen/index.js) runs the model.

## The gates, in order

`evaluate()` in the content script runs these in sequence and stops at the first verdict:

1. **Keyword hit** → hide immediately, model never runs.
2. **No `src` yet** → wait for `load`, then re-evaluate.
3. **Intrinsic size < `minImageSize`** → allow (icons, tracking pixels, sprites).
4. **`analyzeContent` off** → allow (keyword-only mode).
5. **Not decoded yet** → wait for `load`, then re-evaluate.
6. Otherwise → `IntersectionObserver`, and score only once it nears the viewport.

Then in `onVisible()`: **rendered size < `minImageSize`** → allow. An image that is intrinsically large but displayed at 20px is UI chrome.

## Stage 1 — text

`textAround()` in the content script joins `alt`, `title`, `aria-label`, the effective `src` and the wrapping `<a href>`. The matching itself lives in [src/shared/keywords.js](../../../src/shared/keywords.js) — `normalizeText()` lowercases and turns runs of `._/?=&+%#-` into spaces, `compileKeywords()` builds the pattern, `matchesKeyword()` applies it.

It sits in `shared/` rather than in the content script so `npm test` can exercise it directly. Add an assertion there for any change to it: this is the layer whose failure mode (hiding innocent images) the user sees.

Matching is a **single compiled regex** with Unicode letter boundaries:

```js
new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, "iu")
```

That is deliberate. v1 used substring `includes()`, so `sexy` matched inside `essexyachts` and `adult` inside `adulteration`. The boundaries kill those without losing `nsfw-photo.jpg` (punctuation already became a space). The `\p{L}` boundary rather than `\b` is so Hebrew keywords behave.

Keywords live in **one place** — `DEFAULT_KEYWORDS` in [src/shared/settings.js](../../../src/shared/settings.js). v1 duplicated them in `content.js` and `options.js` and they drifted. Do not reintroduce a second copy.

## Stage 2 — the model

nsfwjs 4.3.0 `MobileNetV2` on tfjs, loaded lazily and memoized in the offscreen document — **one instance for the whole browser**, not one per tab.

- Classes: `Neutral`, `Drawing`, `Sexy`, `Porn`, `Hentai`.
- `classify()` is called with no `topk` argument, so it defaults to 5 and returns every class. Passing a `topk` would silently drop classes and produce a filter that never fires.
- The offscreen document returns the **whole class vector**, not a verdict. The worker caches that vector by URL and derives the score at read time, so changing the threshold or `includeSuggestive` reuses every cached result instead of re-running the model.

`riskScore()` in `src/shared/settings.js`:

```js
Porn + Hentai + (includeSuggestive ? Sexy : 0)
```

**This is a sum, not the `max()` v1 used.** The five classes come out of one softmax, so P(unsafe) is the sum of the unsafe classes. `max()` under-detects exactly when confidence is split between `Porn` and `Hentai`. Consequence: at the same numeric threshold the sum fires more readily, which is why the presets moved (`strict` 0.45 → 0.5).

Presets in `SENSITIVITY_PRESETS`: `relaxed` 0.85, `balanced` 0.7, `strict` 0.5. The popup writes these three; the options slider writes any value in 0.2–0.95.

## Getting at the pixels

Two tiers, because one alone does not cover the web:

1. **The offscreen document fetches the URL itself.** Extension pages hold `host_permissions`, so this is not subject to page CORS. `cache: "force-cache"` means it almost always hits bytes the browser already has. It then decodes at 224×224 via `createImageBitmap`'s resize options, which is the model input size, so nsfwjs skips its own resize.
2. **Fallback: the content script draws the element to a canvas** and sends a 224×224 JPEG data URL. This covers same-origin, CORS-clean, `blob:` and `data:` images that the extension origin cannot fetch — auth-gated CDNs, SPA object URLs. `blob:` skips tier 1 entirely since those URLs only resolve inside the page.

A tier-1 miss is cached as `null`, so the next sighting of that URL goes straight to tier 2.

This replaces v1's `classify(imgElement)`, which drew a cross-origin `<img>` into a canvas, tainted it, and threw `SecurityError` on most of the web.

## Failure modes

**Fail open, always.** Unreachable, undecodable or unclassifiable images resolve to `UNKNOWN_SCORE = -1`, which can never cross a threshold. `score()`'s `catch` calls `allow()`. Keep it that way — hiding on classification failure would blur large parts of the web.

**Re-evaluation is wired up.** A settings change resets every tagged element and rescans. An image that was not loaded when first seen gets a one-shot `load` listener. Both were bugs in v1 that made the model effectively never run.

## Cost

Inference is off the page's main thread entirely — it happens in the offscreen document. The remaining levers:

- `MAX_CONCURRENT = 3` in the worker caps parallel inference.
- The `classCache` (LRU, 3000 entries) means a repeated image across tabs is scored once.
- `IntersectionObserver` with a 400px margin means offscreen images are never scored.
- The offscreen document closes after 5 minutes idle, freeing the model and its GPU textures.

## Hiding

Purely CSS-driven, from `src/content/content.css`, keyed on `data-imgfilter="blocked" | "revealed" | "safe" | "pending"`. v1 set inline styles and its disable path forgot to remove half of them; an attribute has no such cleanup problem.

`block()` stashes the page's own `title`/`aria-label` in a `WeakMap` before overwriting them, and `restoreLabels()` puts them back on reveal or reset. Do not overwrite a page attribute without saving it first.

The pre-blur (`src/content/preblur.css`) is registered **dynamically** by the worker via `chrome.scripting.registerContentScripts`, not shipped in the manifest, so it can follow the `hideUntilChecked` setting and the allowlist while still landing before first paint.
