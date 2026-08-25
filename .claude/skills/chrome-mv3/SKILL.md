---
name: chrome-mv3
description: The Manifest V3 platform rules this extension lives by — its permission set and why each one is needed, service-worker and offscreen constraints, dynamic content-script registration, storage areas and quotas, and the remote-code policy. Use when editing manifest.json, adding a chrome.* API or permission, changing what runs where, or preparing a Web Store submission.
---

# Manifest V3 here

## The current surface

```
permissions:      storage, scripting, offscreen, alarms
host_permissions: <all_urls>
background:       src/background/index.js  (type: module)
content_scripts:  dist/content.js + src/content/content.css
                  <all_urls>, document_start, all_frames, match_about_blank
minimum_chrome_version: 116
```

Each permission earns its place, and a reviewer will ask:

| Permission | Why it is here | What breaks without it |
| --- | --- | --- |
| `storage` | settings in `sync`, counters in `local` | everything |
| `scripting` | registering/unregistering the dynamic pre-blur CSS | "hide until checked" stops working |
| `offscreen` | the document that hosts TensorFlow | no content analysis at all |
| `alarms` | the 1-minute tick that closes the idle offscreen document | the model would stay resident forever |
| `host_permissions: <all_urls>` | the offscreen document fetches image bytes to classify them | every image falls back to the canvas-snapshot path, and cross-origin ones become uninspectable |

`host_permissions` is doing real work here — this is not an over-broad grab. The offscreen document is an extension page, so its `fetch` carries the extension's origin and host permissions and is **not** subject to the page's CORS rules. That is precisely what lets v2 inspect images that v1 could not read off a tainted canvas.

## No remote code

The model weights are bundled into `dist/offscreen.js` at build time. Fetching a model, a script, or a rule list from a network origin at runtime violates the Web Store remote-code policy **and** the extension's local-only promise. The only network requests this extension may ever make are `fetch`es of image bytes that the page was already loading anyway, from the offscreen document, with `credentials: "omit"`.

## Service worker

`src/background/index.js` is a module worker. It is **ephemeral** — see the `worker-lifecycle` skill before adding any state to it. In short: no DOM, no `window`, in-memory state dies on suspend, `setTimeout` past a few seconds is unreliable, alarms are the durable timer.

## Offscreen document

At most **one** per extension, ever. `chrome.offscreen.createDocument` rejects if one exists, which is why [src/background/index.js](../../../src/background/index.js) guards with `hasDocument()`, dedupes concurrent creates through a shared promise, and swallows only the "Only a single offscreen" error. The `reasons` and `justification` strings are shown to Web Store reviewers — keep them honest (`BLOBS`, decoding and classifying image data locally).

## Dynamic content-script registration

The pre-blur CSS is not in the manifest. The worker registers it through `chrome.scripting.registerContentScripts` with `persistAcrossSessions: true` so it is present **before first paint**, and re-syncs it whenever settings change. Two consequences:

- The allowlist is enforced twice — as `excludeMatches` on the registration (so allowlisted sites never even flash a blur) and again in the content script's `applySettings`. Both must stay in sync; `toMatchPattern` is the single place that builds the patterns.
- Registration survives browser restarts. `boot()` re-runs `syncPreblur` on every worker wake-up precisely so a stale registration cannot outlive the setting that created it.

## Content script context

`dist/content.js` runs in an **isolated world**: it shares the DOM with the page but not its JavaScript, and it cannot be an ES module (hence the bundle). Available `chrome.*` there is narrow — `chrome.runtime` and `chrome.storage` only. `chrome.tabs`, `chrome.scripting`, `chrome.action` and `chrome.offscreen` do not exist in it; anything needing them goes through a message to the worker.

`document_start` means the DOM may be empty when the script runs — `document.documentElement` can be absent on exotic document types, which is why the observer falls back to `document`.

## Storage

| Area | What belongs there | Limits |
| --- | --- | --- |
| `sync` | user settings (`SETTINGS`) — small, meaningful across devices | 102,400 B total, 8,192 B per item, 512 items, 120 writes/min, 1,800/hour |
| `local` | counters (`STATS`) — noisy, profile-specific | ~10 MB, no sync rate limit |

The 8 KB per-item cap is the real constraint: `keywords` and `allowlist` are single items, so a very long allowlist can hit it. Never put per-URL or per-image data in `sync` — score caches belong in worker memory (they do), and anything larger belongs in `local`.

`onSettingsChanged` filters on `area !== "sync"`. Any new listener must do the same, or a `local` stats write will trigger a full settings re-read in every frame on every scored image.

## Where the extension does not run

`chrome://` pages, the Web Store, other extensions' pages, `view-source:`, and the PDF viewer. `parseHostname` returns `""` for anything that is not `http(s)`, which is what makes the popup say "לא ניתן לסנן את הדף הזה" instead of failing obscurely.
