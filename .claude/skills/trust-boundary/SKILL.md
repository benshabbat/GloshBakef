---
name: trust-boundary
description: What this extension treats as hostile input and how it defends each boundary — page-supplied URLs and the fetch gate, message senders, synced storage, and the response body itself. Use when adding a fetch, a message type, a permission, a stored field, or anything that consumes a value that came off a page.
---

# The trust boundary

The extension runs on `<all_urls>`, holds host permissions for every site, and reads its
inputs off pages it did not write. Four things arrive from outside and none of them are
trusted.

## 1. URLs, and the fetch gate

Every URL the worker is asked about comes out of page markup. The offscreen document
fetches it as an extension page, which means **with the extension's host permissions** —
not under the CORS and Private Network Access rules the page itself lives under. Without a
gate, a hostile page could point an `<img>` at the user's router, at `169.254.169.254`, or
at a service on localhost, and have the extension issue the request on its behalf.

`isFetchableUrl()` in [urls.js](src/shared/urls.js) is that gate:

- `data:` — allowed. It carries its own bytes; fetching one reaches no host.
- `http:` / `https:` — allowed only if the host is public.
- everything else, `blob:` included — refused. A page's blob URL only resolves inside that
  page, so the extension could never fetch it anyway.
- refused hosts: `0/8`, `10/8`, `127/8`, `169.254/16`, `172.16/12`, `192.168/16`,
  `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.home.arpa`, `[::1]`, `fc00::/7`,
  `fe80::/10`. The URL parser has already canonicalised the host, so
  `http://2130706433/` arrives as a dotted quad and is covered.

**The property that makes the gate free: a refusal costs no coverage.** A refused URL is
not dropped — it returns `needsPixels`, and the content script re-asks with pixels drawn
from the element the page had already decoded. Same picture, no request. If you ever add a
refusal that has no pixel fallback behind it, you have traded a security boundary for a
coverage hole; find another way.

Any new URL that reaches a `fetch` goes through `isFetchableUrl()` first, and gets test
cases in `scripts/test.mjs` alongside the existing ones.

## 2. Message senders

`chrome.runtime.onMessage` fires for messages from the content script, the UI pages and
the offscreen document alike, and a content script is *any page on the web*. The sender is
part of the input.

- `TAB_STATE` carries a `tabId` the caller chose. The handler refuses any sender with
  `sender.tab` — that is a content script, and it has no business reading another tab's
  count. Only extension pages (the popup) have no `sender.tab`.
- `REPORT` deliberately ignores the message's idea of who it is and uses
  `sender.tab.id` / `sender.frameId`. A frame can only ever report its own count.
- Worker↔offscreen messages carry `target: "offscreen"`; the worker returns `false`
  immediately for those and the offscreen listener refuses anything without it. Both ends
  guard — see the `messaging` skill.

**Rule: if a handler acts on an identifier from the message body rather than from
`sender`, it needs a sender check.** Write down which senders are legitimate, in a comment,
next to the check.

## 3. Storage

`chrome.storage.sync` is written by whichever version of the extension got to the profile
first and synced from other machines. It is untrusted input, not a private field.

`migrate()` re-parses it **entry by entry**, not merely by type:

- numbers: `Number(...)`, rounded where integral, clamped to `BOUNDS`, with a fallback for
  `NaN` — and for `videoSampleSeconds` the fallback is the default rather than `0`, which
  would busy-loop the sampler.
- `keywords`: trimmed, lowercased, empties dropped, de-duplicated.
- `allowlist`: every entry through `parseHostname()`, which rejects non-http(s) schemes and
  anything that fails `/^[a-z0-9.-]+$/`.

The allowlist one is load-bearing, and the failure is silent: one unusable entry makes
`toMatchPattern()` emit `*:///*`, Chrome rejects the **entire** `registerContentScripts`
call over it, and "hide until checked" quietly stops working everywhere. That is why the
registration failure is `console.warn`ed rather than swallowed.

A new stored field is sanitized in `migrate()` and nowhere else — see `add-setting`.

## 4. The response body

The URL says "image"; the bytes are whatever the host feels like sending.

- The declared `content-length` is rejected **before** the body is pulled into memory.
- `blob.size` is checked again for responses that declare no length, and `0` is rejected.
- `blob.type`, when present, must start with `image/`.
- `MAX_BYTES` is 12 MB; `FETCH_TIMEOUT_MS` is 10 s, enforced with an `AbortController`.
- `credentials: "omit"` — the extension must never fetch an image *as the user*. If the
  picture needs the user's cookies, the page already has it decoded, and the pixel path
  reaches it without sending anything.
- `cache: "force-cache"` — prefer the copy the browser already has over a new request.

## Lines that must not be crossed

These are the promises in the store listing and the README, and they are what the
`privacy-auditor` and `store-reviewer` agents check:

- **No remote code, ever.** Not a script tag, not a CDN, not model weights fetched at
  runtime, not a remote config. The model is bundled in `dist/offscreen.js`. This is both
  the MV3 policy and the local-only promise.
- **Nothing about browsing leaves the device.** No analytics, no error reporting, no URL
  ever sent anywhere. The only outbound requests the extension makes are image fetches to
  hosts the page already referenced.
- **No image bytes leave the device**, and none are persisted. The class-probability cache
  is keyed by URL, holds vectors, lives in worker memory, and dies with the worker.
- **No new permission without a written reason.** `storage`, `scripting`, `offscreen`,
  `alarms` and `<all_urls>` each have one; anything added needs one that survives a store
  reviewer reading it.

## Adding something that crosses a boundary

- New fetch → `isFetchableUrl()`, a size cap, a timeout, `credentials: "omit"`, tests.
- New message → who may send it, checked against `sender`; both ends guarded; see
  `messaging`.
- New stored field → sanitized in `migrate()`, with a test for the malformed case.
- New permission → justified in the manifest discussion, the README and the store answers;
  see `chrome-mv3` and `release`.
