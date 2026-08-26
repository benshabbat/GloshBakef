---
name: fail-open
description: The invariant the whole extension is built around — when anything goes wrong, the image stays visible. Covers the UNKNOWN_SCORE sentinel and the threshold floor that make it arithmetic rather than a promise, every error path that must end in allow(), the one place hiding-on-uncertainty is allowed, and how to break the extension on purpose to check it still holds. Use before changing any error path, adding a block() call site, or touching the threshold bounds.
---

# Fail open

The extension is allowed to miss something. It is not allowed to blur the web.

That asymmetry is the product decision behind almost every odd-looking piece of error
handling here. A missed image is a filter that is imperfect; a page of blurred rectangles
because the worker was asleep is a broken browser, and the user uninstalls. So **every
uncertainty resolves to visible.**

## It is arithmetic, not discipline

```js
UNKNOWN_SCORE = -1            // src/shared/messages.js
BOUNDS.threshold = [0.2, 0.95] // src/shared/settings.js
riskScore(null, …) === -1
```

`migrate()` clamps `threshold` to that range, so the lowest threshold any user can reach is
`0.2` and `-1 >= 0.2` is false. Nothing that failed can cross any threshold, at any
setting, ever. `scripts/test.mjs` asserts it against each preset by name.

**Do not lower `BOUNDS.threshold[0]` to 0, and do not let any code path compare a score to
a threshold that came from somewhere other than migrated settings.** Those two lines are
the whole guarantee.

## Every path that must end visible

The content script:

| Failure | Where | Ends in |
| --- | --- | --- |
| Worker asleep, gone, or a version mismatch | `requestScore()` catch | `UNKNOWN_SCORE` |
| Image failed to load | `waitForLoad()` → `failed` | `allow()` — a broken image shows nothing |
| No source at all | `score()` | `allow()` |
| Tainted canvas, `toDataURL` throws | `snapshot()` returns `null` | `UNKNOWN_SCORE` |
| Video with no readable frame and no poster, frame checking off | `evaluateVideo()` | `allow()` |
| Poster unreachable (`needsPixels`, no pixel fallback exists) | `sampleVideo()` | `UNKNOWN_SCORE` |
| Element below `minImageSize`, intrinsic or rendered | `evaluate()` / `onVisible()` | `allow()` |
| `analyzeContent` off | `evaluate()` | `allow()` |

The worker:

| Failure | Where | Ends in |
| --- | --- | --- |
| `scoreImage()` rejects | the `onMessage` handler's second callback | `sendResponse({ score: UNKNOWN_SCORE })` |
| A queued job throws | `pump()`'s `.catch(() => null)` | `null` classes |
| Offscreen document torn down mid-send | `runModel()` retries once, then throws | caught above |
| URL refused by the gate, or `pixelsOnly` | `scoreImage()` | `{ UNKNOWN_SCORE, needsPixels: true }` |
| Model returned nothing and pixels were already attached | `scoreImage()` | `{ score: UNKNOWN_SCORE }` |

The offscreen document: `toBitmap()` returns `null` for a non-`ok` response, an
over-`MAX_BYTES` body, a non-image MIME type, an abort at `FETCH_TIMEOUT_MS`, or any
throw; `classify()` returns `null` if the model throws. `null` classes become
`UNKNOWN_SCORE` upstream.

Note what `cacheSet(url, null)` means: **"could not be fetched"**, not "unsafe". A cached
`null` is replayed as `needsPixels`, which sends the caller down the pixel path — the same
picture, reached without the extension touching the network.

## The one exception, and why it is safe

`hideUntilChecked` blurs everything from first paint, including `pending`. That *is*
hiding on uncertainty, and it is opt-out rather than opt-in because the alternative — a
flash of the thing the user asked not to see — defeats the point of the extension.

Three things keep it from becoming a trap:

1. Every `pending` path has a terminating event. `waitForLoad()` listens for `load`,
   `loadeddata` **and** `error`, and detaches on all three. A `pending` with no event left
   to fire is a permanently blurred element — this was a real bug for posterless videos.
2. The click-to-reveal handler treats `pending` as hidden **only while `hideUntilChecked`
   is on**, so an element that never finishes loading can still be revealed by clicking it.
3. The popup's "חשיפת הכל בדף הזה" reveals every frame in the tab unconditionally.

If you add a state that the pre-blur CSS hides, you owe it all three.

## Directional rules

- **Re-sampling only ever blocks.** `resample()` has no `allow()` branch. A video that was
  cleared and is being re-checked can become hidden; a hidden one never un-hides itself.
  Otherwise the blur flickers and a user's reveal comes undone.
- **`revealed` is terminal** for that source. Only a source change or a settings change
  that invalidates verdicts can move an element out of it.
- **A miss is cheap, a false block is not.** `MAX_VIDEO_MISSES` exists so a DRM video is
  abandoned rather than re-asked forever, and abandoning it means leaving it visible.

## Reviewing a change

A change that hides an image on a failure path is a blocking finding, not a preference.
Concretely, ask of every new `block()` call site: *what is the positive evidence?* There
are exactly two legitimate answers — a keyword matched, or a score at or above the
threshold. "We could not tell" is not one of them.

Then check the reverse: does the new path have an `allow()` on **every** exit, including
the `catch` and the early returns?

## Checking it still holds

`npm test` covers the arithmetic. The rest needs a browser (see `test-extension`):

- **Kill the service worker** mid-scroll (`chrome://extensions` → terminate). Images
  in flight must resolve visible, not stay blurred. The badge count is expected to be lost.
- **A cross-origin image with no CORS headers that the extension cannot fetch either.** It
  stays visible. Verify this one specifically — it is the path that fails open most often
  in real use.
- **Wait out the 5-minute idle shutdown**, then load an image-heavy page. The offscreen
  document and model reload; the first image is slow, nothing hangs, nothing is stuck
  blurred.
- **A DRM video** (a paid streaming page). Unreadable frames, three misses, then left
  alone and visible.
- **`chrome://` and the Web Store.** The filter does not run; the popup says
  "לא ניתן לסנן את הדף הזה" and the worker console is clean.
