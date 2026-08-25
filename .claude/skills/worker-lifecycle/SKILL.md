---
name: worker-lifecycle
description: How the ephemeral MV3 service worker and the single offscreen document actually behave here — what dies on suspend, why boot() runs on every wake, why alarms replace timers, and how the model is kept warm without leaking it. Use when adding state or timers to the service worker, touching the offscreen document's lifecycle, or debugging behavior that only appears after the extension has been idle.
---

# Worker and offscreen lifecycle

## The service worker is not a background page

`src/background/index.js` is terminated after ~30 seconds of inactivity and restarted on the next event. **Everything in module scope is lost on suspend**:

| State | Lost on suspend | Consequence |
| --- | --- | --- |
| `classCache` (LRU, 3000 vectors) | yes | images get re-fetched and re-scored after a quiet period — a cost, not a bug |
| `tabCounts` | yes | the badge count for open tabs resets; the content script only re-reports when a verdict changes |
| `queue` / `running` | yes | in-flight scores are abandoned; the content script's `catch` fails them open |
| `settingsCache` | yes | re-read from storage on the next use |
| `statsChain` | yes | harmless — it only serializes concurrent writes within one worker life |
| `offscreenReady` | yes | `hasDocument()` re-establishes the truth |

Before you put anything in a module-level variable, ask what happens when it vanishes. If the answer is "the user notices", it belongs in `chrome.storage.local`, not in memory. If the answer is "we redo some work", memory is correct — which is why the score cache lives there.

The badge is the honest edge case: after a worker restart the count can read empty while images are still blurred on screen. That is a known, accepted trade — do not "fix" it by persisting per-tab counts to storage on every image.

## boot() runs three times, on purpose

```js
chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);
boot();                                   // and on every worker wake-up
```

Everything `boot()` does is **idempotent**: setting the badge color, creating an alarm that already exists, and re-syncing the pre-blur registration. The top-level call is what self-heals a profile where a previous session left the dynamic content script out of step with the settings. Anything added to `boot()` must be idempotent too — no counters, no appends, no "first run" side effects that are not guarded by `onInstalled`.

## Alarms, not timers

`setTimeout` in a service worker does not survive suspension, and a long timeout keeps nothing alive. The idle shutdown is therefore an **alarm** ticking every minute, checking `Date.now() - lastActivity` against a 5-minute threshold and whether the queue is empty. Sub-minute periods are not reliable — an alarm is the wrong tool for anything that needs sub-second precision.

Short debounce timers inside the *content script* are fine (`scheduleReport`, `scheduleBackgroundScan`) — that context lives as long as the page.

## The offscreen document

One per extension, no exceptions. The lifecycle rules that matter:

- `ensureOffscreen()` checks `hasDocument()` first, then dedupes concurrent creates through a shared `offscreenReady` promise, and swallows **only** the "Only a single offscreen" rejection — anything else is a real failure and must keep propagating. Do not broaden that catch.
- The document can disappear between `ensureOffscreen()` and the `sendMessage` that follows. `runModel` retries exactly once for that reason.
- Closing it frees the model, its weights and its WebGL textures. Reopening costs a model load (seconds, once). The 5-minute idle window is the balance point; shortening it trades user-visible latency for memory.
- It is invisible and can be closed at any moment. Never put user-facing UI, long-lived state, or anything unsaved in it. It is a stateless classifier that happens to cache a model.

## The scoring queue

`MAX_CONCURRENT = 3` with a hand-rolled queue. Three matters: the offscreen document runs on one thread with one WebGL context, so more concurrency does not buy throughput, it buys memory pressure and latency variance. `pump()` decrements `running` and re-pumps in a `.then` attached after `.catch(() => null)`, so a rejected job cannot wedge the queue at `running > 0` forever. Preserve that shape if you touch it.

## Stats writes are serialized

`recordStats` chains onto `statsChain` because two concurrent `get` → `set` pairs on `chrome.storage.local` lose an increment. The chain swallows errors so one failed write cannot poison every later one. Any future read-modify-write against storage needs the same treatment.

## Testing suspension

`chrome://extensions` → inspect the service worker → close the inspector and wait, or use the **terminate** control, then interact with a page. The behaviors to confirm: images still resolve (fail open at worst), the offscreen document is recreated, `boot()` did not double-register anything, and no unhandled rejection appears in the worker console on wake.
