---
name: messaging
description: The message protocol between the content script, the service worker, the offscreen document and the UI pages — who listens to what, the target-routing trick, the sendResponse contract, and how to add a message without deadlocking a caller. Use when adding or changing any chrome.runtime/chrome.tabs message, or when a sendMessage call hangs, returns undefined, or throws.
---

# The message protocol

All names live in [src/shared/messages.js](../../../src/shared/messages.js). Never inline a string literal.

| Message | From → to | Response |
| --- | --- | --- |
| `SCORE` | content script → worker | `{ score }` or `{ score, needsPixels: true }`, async |
| `SCORE_OFFSCREEN` | worker → offscreen | `{ classes }` or `{ classes: null }`, async |
| `REPORT` | content script → worker | none (fire and forget) |
| `TAB_STATE` | popup → worker | `{ blocked }`, sync |
| `REVEAL_ALL` | popup → content script (all frames) | none |

## The routing rule that is easy to get wrong

`chrome.runtime.sendMessage` broadcasts to **every extension context that has a listener** — the service worker, the offscreen document, an open popup, an open options page. It does **not** reach content scripts; those are addressed only with `chrome.tabs.sendMessage(tabId, …)`.

So when the worker scores an image, its own `onMessage` listener also receives the message it just sent to the offscreen document. That is what the `target` field is for:

```js
// worker: someone else's mail
if (message?.target === "offscreen") return false;

// offscreen: only mail addressed here
if (message?.target !== "offscreen" || message.type !== MSG.SCORE_OFFSCREEN) return false;
```

Any new worker↔offscreen message must carry `target: "offscreen"` and both guards. Any new broadcast message must be ignored explicitly by contexts that are not its recipient — a popup that happens to be open when a `SCORE` flies past must not answer it.

## The sendResponse contract

Returning `true` from an `onMessage` listener keeps the response channel open for an async `sendResponse`. Returning anything else closes it immediately, and a caller awaiting a reply gets `undefined`.

The rules that follow from that:

- **Async handler → `return true`, and every path must call `sendResponse`.** `SCORE` does this with `.then(sendResponse, () => sendResponse({ score: UNKNOWN_SCORE }))` — note the rejection handler. A handler that returns `true` and then throws leaves the caller hanging until the channel is garbage-collected.
- **Sync handler → call `sendResponse` and return `false`.** `TAB_STATE` does this.
- **Fire-and-forget → return `false`** and let the sender ignore the reply. `REPORT` does this.
- Only one listener may answer a given message. Two listeners both returning `true` is a race over who responds first.

## Every send can fail, and that is normal

`chrome.runtime.sendMessage` **rejects** when no receiver is listening — the worker was asleep and is still spinning up, the offscreen document was torn down, the tab navigated away mid-flight, the extension was reloaded under an open page. This is routine, not exceptional.

Consequently every send site in this codebase handles failure, and any new one must too:

- `score()` in the content script wraps the whole exchange in `try/catch` and calls `allow(element)` — **failing open**, never leaving an image blurred because a message was lost.
- `scheduleReport` and the popup's `TAB_STATE` call use `.catch(() => …)` with a neutral fallback.
- `runModel` in the worker retries **once**, because the offscreen document can be closed between `ensureOffscreen()` and the send. One retry is deliberate: a second failure is a real error, and a retry loop against a document that cannot be created would spin forever.

A stale content script from a previous extension version is a permanent receiver failure — the page keeps running the old bundle until it is reloaded. Do not add retry logic to paper over it.

## Broadcast to frames

`chrome.tabs.sendMessage(tabId, msg)` with no `frameId` delivers to **every frame** in the tab. `REVEAL_ALL` relies on that: each frame reveals its own images. If a future message must reach only the top frame, pass `{ frameId: 0 }` explicitly.

Incoming messages carry `sender.frameId` and `sender.tab.id`. `REPORT` uses both to keep a per-frame count, so a page with iframes does not have its badge overwritten by whichever frame reported last.

## Adding a message

1. Add the name to `MSG` with a comment saying the direction.
2. Decide sync vs. async, and honor the `return true` contract on **every** path.
3. If it crosses into the offscreen document, add `target: "offscreen"` and both guards.
4. Handle a rejected send at the call site with a safe default — for anything on the image path, the safe default is "do not hide".
5. Rebuild: content-script and offscreen changes only reach the browser through `dist/`.
