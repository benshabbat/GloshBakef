---
name: content-state-machine
description: The per-element verdict machine inside the content script — element identity, the pending/safe/blocked/revealed states, the staleness guard, what block() must give back, the two observers, subtree cleanup, and the video sampler. Use when editing src/content/index.js, adding a verdict path, or debugging an element stuck on pending, double-counted, or blurred after a reveal.
---

# The verdict state machine

`src/content/index.js` is one state machine per element, run in every frame. It is the
largest and most delicate file here: every bug that survived a release lived in this file,
and all of them were the same three kinds — a stale answer applied to a changed element, a
`block()` with no matching restore, or an element that entered `pending` and had no event
left to leave it.

## The four states

Written onto the element itself, so the CSS and DevTools can both see them.

| Attribute | Values | Set by |
| --- | --- | --- |
| `data-imgfilter` | `pending`, `safe`, `blocked`, `revealed` | `mark()` — always through `mark`, never directly |
| `data-imgfilter-bg` | `safe`, `blocked`, `revealed` | the CSS background pass, keyword-only |
| `data-imgfilter-off` | `"true"` on `<html>` | `teardown()`, when the frame is inert |

`revealed` is terminal for that source: nothing re-scores it until the source changes or a
settings change wipes every verdict. That is deliberate — a user's reveal must stick.

No attribute at all means *never evaluated*. That is a scanning problem, and a completely
different bug from `pending`, which means *evaluated, still waiting*. Distinguish the two
before you debug either.

## The bookkeeping

```
records        WeakMap  element -> { src, status, sampledAt, misses }
pendingLoad    WeakSet  elements with load listeners attached
originalLabels WeakMap  element -> { title, ariaLabel } as the page had them
originalPlayback WeakMap video -> { muted, paused } as the page left it
watchedVideos  WeakSet  videos already carrying playback listeners
liveVideos     Set      cleared videos on screen, still worth re-checking
```

`liveVideos` is the only strong collection, and the `IntersectionObserver` also holds its
targets strongly. Those two are why `forget()`/`release()` exist: without them an infinite
video feed pins every video it ever showed for the life of the page. Anything strong you
add here needs a removal path in `release()`.

## Identity is `sourceOf(element)`

`currentSrc || getAttribute("src")` and, for a video only, `poster` as the fallback. It is
both the cache key and the URL the worker is asked about. Every `records` entry is scoped
to one source string, and that is what makes staleness detectable.

## `evaluate()` — the gates, in order

1. Not active, or not `<img>`/`<video>` → return.
2. Same source, not `pending`, no `force` → return. SPAs rewrite `src` constantly; without
   this gate a feed re-scores the whole viewport on every mutation batch.
3. New record — `{ src, status: "pending", sampledAt: 0, misses }`. **`misses` survives a
   same-source re-evaluation.** A DRM video firing `loadeddata` repeatedly would otherwise
   reset the counter forever and never reach `MAX_VIDEO_MISSES`.
4. Keyword hit → `block()`. No model, no viewport wait.
5. Empty source → wait for load. Only for images: a video legitimately has no `src` of its
   own (MSE, `<source>` children).
6. Intrinsic size below `minImageSize` → `allow()`.
7. `analyzeContent` off → `allow()`.
8. Video → `evaluateVideo()`.
9. Image not `complete` → wait for load.
10. Otherwise `pending` + observe for the viewport.

`force = true` is for callers that know the picture changed while the source string did
not: a finished load, or an `emptied` event from an MSE swap. Pass the flag; never null out
`record.src` to fake it.

## The staleness guard

Every `await` in this file is a window in which the element can be swapped, removed,
revealed by the user, or reset by a settings change. So no result is ever applied without
re-checking first:

```js
if (!stillPending(element, src)) return;   // active && record.src === src && status === "pending"
```

Checking the source alone is not enough — that was the bug where a late verdict overwrote a
reveal the user had already made. `resample()` runs the same check against `"safe"`, since
that is the state it is allowed to act on.

**Rule: if you add an `await` between reading an element and writing its verdict, a
staleness check goes after it.**

## Symmetry: what `block()` takes, something must give back

`block()` does five things. Every one of them has to be undone by `unblock()` and by
`reset()`:

| `block()` | Undone by |
| --- | --- |
| stashes `title`/`aria-label`, writes the Hebrew hidden label | `restoreLabels()` |
| pauses and mutes a video, stashing `{ muted, paused }` | `restorePlayback()` |
| `state.blocked += 1` | the guarded decrement in `unblock()` / `reset()` |
| `mark(element, "blocked")` | `mark()` with the new state, or attribute removal |
| `scheduleReport()` | `scheduleReport()` on the way out |

The counter is guarded on both ends: `block()` returns early if the element is already
`blocked`, and the decrements are `Math.max(0, …)`. A path that decrements without having
incremented drifts the badge, and the badge is per-tab worker memory — it does not
self-heal until navigation.

`restorePlayback` skips `play()` on a detached element: it also runs from `reset()` while
cleaning up removed nodes, and autoplay policy can refuse it outside a user gesture
anyway.

## The two observers

**`IntersectionObserver`** — `rootMargin: 400px`, so scoring starts before the element is
on screen. Images are `unobserve`d on their first intersection; videos stay observed,
because leaving the viewport is what stops their sampling loop (`liveVideos.delete`). The
rendered-size gate runs here rather than in `evaluate()`, because at `document_start` the
element has no box yet.

**`MutationObserver`** — `childList` + `subtree` + `attributeFilter: ["src", "srcset",
"poster", "alt", "title"]`. Attribute mutations go straight to `evaluate()`; added subtrees
go to `scan()`; removed subtrees go to `forget()`. `release()` checks `isConnected` first,
because a DOM *move* arrives as a removal followed by an insertion and the node is already
back by the time the callback runs.

The background scan is scheduled once per mutation batch, not per added node — a page that
inserts a thousand nodes at once would otherwise churn a thousand timers.

## Settings changes

`applySettings()` is the only entry point for a settings change, and it decides between
three outcomes:

- Inactive now (disabled or allowlisted) → `teardown()`: disconnect the DOM observer, set
  `data-imgfilter-off`, clear every verdict, report zero. Disconnecting matters — an
  allowlisted page must not keep paying for mutation callbacks whose verdicts are never
  reached.
- Active, and a field in `SCORING_FIELDS` changed → `clearAllVerdicts()` then re-scan. Every
  earlier verdict was computed under the old value and is now meaningless.
- Active, and only a "what happens next" field changed (`clickToReveal`,
  `hideUntilChecked`, `videoSampleSeconds`) → nothing. Those decide behaviour, not
  verdicts.

**A new setting that can change a verdict must be added to `SCORING_FIELDS`.** Forgetting
that is invisible in testing until someone flips it with a page already open.

## The video sampler

A video is a moving target, so it is judged on its own frames and re-judged while it runs.

- `watchVideo()` attaches one-time listeners: `play` (start the loop and sample now),
  `seeked` (sample now), `emptied` (`evaluate(force)` — MSE swapped the movie without
  touching an attribute).
- `keepWatching()` puts a cleared, on-screen video into `liveVideos`; `videoPass()` ticks
  every `videoSampleSeconds`, skips paused/ended videos, and lets the loop die when nothing
  is playing rather than ticking forever. The `play` listener restarts it.
- `MIN_SAMPLE_GAP_MS` floors two looks at the same video, so scrubbing cannot spam the
  model.
- Frame requests carry `cache: false`. The worker's cache is keyed by URL and a video URL
  returns a different picture every few seconds.
- **Re-sampling only ever blocks.** `resample()` has no `allow()` path, so the blur cannot
  flicker and a reveal cannot be undone.
- `countMiss()` gives up after `MAX_VIDEO_MISSES` unreadable looks — DRM never becomes
  readable — but one failed round-trip to a sleeping worker is not a reason to stop.

## The CSS background pass

Separate, keyword-only, and deliberately weaker: `scanBackgrounds` walks every element,
reads `getComputedStyle().backgroundImage`, and matches the keyword regex against the URL
text. It is off by default because it walks `*` and forces a style resolve — so it runs
debounced, inside `requestIdleCallback`. Tagged elements are marked `safe` before the size
check, so each element is only ever examined once. There is no model path here and no
`records` entry: these elements are not part of the machine above, only of the counter.

## Adding a verdict path

1. Where does it sit among the gates in `evaluate()`? Order is meaning — the keyword pass
   is first because it needs no bytes, the size gates are before the model because they
   are free.
2. Does it end in `allow()`, `block()`, or `pending` + an event? A `pending` with no
   terminating event is a permanently blurred element under "hide until checked".
3. Is there an `await`? Then a `stillPending()` check after it.
4. Does it hide something new? Then it needs a restore in `unblock()` **and** `reset()`.
5. Does it hold a strong reference? Then a removal in `release()`.
6. Does it depend on a setting that can change a verdict? `SCORING_FIELDS`.
7. `npm run check && npm run build` — this file is bundled; sources alone do not reach the
   browser.

## Traps

- The content script runs in the **isolated world**: no `chrome.tabs`, `chrome.scripting`
  or `chrome.offscreen`. Only `chrome.runtime` and `chrome.storage`.
- At `document_start` `document.documentElement` may not exist. Both uses are guarded
  (`?.`) and `observeDom()` falls back to `document`.
- `state.blocked` is per frame; the worker sums frames per tab. A frame that goes away
  reports `0` on `pagehide` unless it is only entering the back/forward cache
  (`event.persisted`), where it reports again on `pageshow`.
- The click handler runs in capture and calls `stopImmediatePropagation()`, so revealing
  never triggers the page's own navigation. It treats `pending` as hidden **only** while
  `hideUntilChecked` is on — that is what gives an image that never finished loading a way
  out of the blur.
- `snapshot()` reuses one canvas, and a canvas that has had a tainted image drawn into it
  stays tainted for life. That is why the canvas is only kept after `toDataURL` succeeds,
  and dropped otherwise. Do not "optimise" that away.
