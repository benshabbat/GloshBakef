---
name: page-styling
description: The CSS this extension injects into other people's pages — content.css and the dynamically registered preblur.css, why hiding is a filter rather than a display change, the !important and specificity rules, and the layout traps of blurring an element you do not own. Use when changing how a hidden image looks, adding a visual state, or investigating a page the extension visually breaks.
---

# Styling other people's pages

Two stylesheets reach the web, and they are not the same kind of thing as the UI styles in
`src/ui/` (those are covered by `rtl-ui`). These run inside pages written by people who
have never heard of this extension.

| File | How it gets there | When it applies |
| --- | --- | --- |
| `src/content/content.css` | manifest `content_scripts`, `document_start`, all frames | always; inert until an element is tagged |
| `src/content/preblur.css` | `chrome.scripting.registerContentScripts()` from the worker | only while `enabled && hideUntilChecked` |

## content.css only styles what was tagged

Every selector is anchored on `data-imgfilter` or `data-imgfilter-bg`. The stylesheet is
present on every page in every frame from first paint and does nothing at all until the
content script writes a verdict onto an element. That is the property to preserve: **no
rule may match an element the script has not tagged.**

## preblur.css is registered, not shipped

It could have been a second entry in the manifest, gated at runtime — but then it would
have to be turned *on* by script, and anything that happens after first paint is a flash of
the thing the user asked not to see. Registering it instead means it is already in the
page before the first paint, and turning it off is a matter of not registering it.

Its gate is CSS, not JS:

```css
:root:not([data-imgfilter-off]) img:not([data-imgfilter]),
:root:not([data-imgfilter-off]) img[data-imgfilter="pending"], …
```

- `:not([data-imgfilter])` — never evaluated yet. Blurred.
- `[data-imgfilter="pending"]` — evaluated, waiting. Blurred.
- `safe` / `blocked` / `revealed` — a verdict exists; content.css owns it from here.
- `data-imgfilter-off` on `<html>` — `teardown()` sets it, and the whole sheet stops
  matching. This is how an allowlisted page unblurs instantly without waiting for the
  worker to unregister the script.

`excludeMatches` from the allowlist covers the next page load; the `off` attribute covers
the page that is already open. Both exist because the two act at different times.

## Why `filter`, not `display: none`

Hiding by removing the element, blanking `src`, or `display: none` would each reflow the
page — an image-heavy feed would visibly collapse and rebuild as verdicts land, and every
site's layout would break differently. `filter: blur()` plus `opacity` costs no layout at
all: the box keeps its size, the page keeps its shape, the element is still there to be
revealed, and reversing it is one attribute change.

The trade is honest and worth knowing: the image is still loaded and still in the page, so
this hides it from the user, not from the browser. The page's own request already happened
before the extension ever saw the element.

## `!important`, and the debt it creates

Page CSS specificity is unknowable, so every declaration here is `!important`. The
consequence: **the "revealed" rule must reset every property the "blocked" rule set.**
Today that is `filter`, `opacity` and `outline`. Add a property to the blocked rule — a
`transform`, a `clip-path`, a `content` — and the revealed rule grows with it, or a
revealed image keeps a piece of its blur forever.

Same for `data-imgfilter-bg`: it has its own blocked and revealed rules and they must stay
in step.

## The states, visually

- **blocked** — 28 px blur, full grayscale, 35 % opacity, dashed accent outline inset by
  2 px, a hatched background so a fully transparent PNG still reads as hidden,
  `cursor: pointer` to advertise click-to-reveal.
- **pending** (pre-blur only) — 12 px blur and nothing else. Deliberately lighter: it is
  the transient state and most of what it covers turns out to be safe.
- **revealed** — everything reset.
- **safe** — no rule. Untouched.

Transitions are 140 ms on `filter` and `opacity`, and dropped entirely under
`prefers-reduced-motion: reduce`. A blur animating in on every image of a long feed is
exactly the kind of motion that reduced-motion exists for.

The accent green `#315d4b` matches `--accent` in `ui.css`, but it is written out literally:
page CSS cannot read custom properties defined in an extension page, and defining them on
`:root` here would leak variables into the page's own cascade.

## Traps

- **`filter` creates a containing block and a stacking context.** For an `<img>` that is
  harmless. For `data-imgfilter-bg`, which lands on arbitrary elements chosen only because
  they have a `background-image`, it is not: a `position: fixed` descendant will start
  positioning against that element instead of the viewport. This is a known cost of the
  background pass, which is why it is off by default.
- **A filter blurs the whole subtree.** Blurring a background layer blurs the text on top
  of it. Again the background pass, again a known limitation — do not "fix" it by moving
  the filter to a pseudo-element without checking what happens to backgrounds that are
  painted on the element itself.
- **Blur is GPU work proportional to painted area.** A 28 px blur on a hero-sized element
  is not free; on a page with hundreds of blurred thumbnails it is noticeable. Ask
  `perf-auditor` before raising the radius.
- **`opacity` below 1 on a video keeps it composited.** Pausing a blocked video (the
  `pauseBlockedVideos` setting) is what actually stops the cost, not the blur.
- **Do not add rules that match by tag or class alone**, and do not inject a `<style>` at
  runtime — the manifest and the registered script are the only two ways CSS reaches a
  page here, and `check.mjs` verifies both paths exist.
- Changing either file needs no rebuild — they are shipped as sources, not bundled — but
  `preblur.css` is referenced by string from the worker, so a rename must be made in
  `src/background/index.js` too. `npm run check` catches that.
