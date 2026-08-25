---
name: build-extension
description: Build and verify the bundles for this Chrome extension. Use whenever anything under src/ changes, before committing, or when dist/ may be stale. Also covers reloading the extension in Chrome so a build is actually picked up.
---

# Building this extension

## What is built and what is not

Two esbuild entry points, both written to `dist/` (which is **gitignored** — the tree must be built before it can be loaded):

| Entry | Output | Size | Why bundled |
| --- | --- | --- | --- |
| `src/content/index.js` | `dist/content.js` | ~7 KB | Content scripts cannot be ES modules, so its imports must be inlined. |
| `src/offscreen/index.js` | `dist/offscreen.js` | ~4.5 MB | Carries tfjs + the nsfwjs MobileNetV2 weights. |

Everything else is loaded directly by Chrome and needs **no build**, only an extension reload:

- `src/background/index.js` — a `"type": "module"` service worker, so it can `import` from `src/shared/`.
- `src/ui/popup.js`, `src/ui/options.js` — loaded as `<script type="module">` from extension pages.
- All `.css` and `.html`.

**`src/shared/` is consumed both ways, and this is the trap.** The service worker and the UI pages import it raw off disk; the two bundles compile a *copy* of it into `dist/`. Edit `shared/settings.js` without rebuilding and the worker runs the new logic while the content script and the offscreen document run the old one — same defaults, different behavior, no error anywhere. Always rebuild after touching `src/shared/`.

`dist/offscreen.js` is generated output with the model weights inlined. **Never Read or grep it into context** — it will blow the context window. Grep `src/` or `node_modules/<pkg>/dist` instead.

## The loop

```
npm run build     # icons + both bundles
npm run dev       # same, then esbuild watch mode
npm run check     # manifest paths, HTML asset refs, syntax across src/ and scripts/, then npm test
npm test          # the pure-logic assertions in scripts/test.mjs, on bare Node
npm run icons     # regenerate icons/*.png only
```

`npm install` first if esbuild is missing (esbuild, nsfwjs and @tensorflow/tfjs are devDependencies — nothing ships from `node_modules/`).

## The tfjs alias — do not remove it

`scripts/build.mjs` aliases `@tensorflow/tfjs` (which nsfwjs imports) to `src/offscreen/tf.js`, a slim re-export of core + converter + layers + the cpu/webgl backends. Without that alias the bundle pulls tfjs-data, the node backends, **and all three nsfwjs models** — 40 MB instead of 4.5 MB.

`tfjs-layers` is required: the nsfwjs MobileNetV2 definition has no `type: "graph"`, so `NSFWJS.load()` goes through `tf.loadLayersModel`.

## Before you call a change done

1. Rebuild if you touched `src/content/` or `src/offscreen/` — Chrome runs `dist/`, not the source.
2. `npm run check` passes.
3. Sanity-check sizes in the build output. `dist/content.js` should stay in the single-digit KB range; if it jumps to megabytes, something dragged tfjs into the content script, which is the exact regression this architecture exists to prevent. `dist/offscreen.js` dropping far below ~4 MB means the model weights got dropped and classification will silently fail open.
4. Nothing in `dist/` is committed. A fresh clone runs `npm install && npm run build`.

## Making a build visible in Chrome

1. `chrome://extensions` → reload button on this extension.
2. Reload any already-open tab. Content scripts inject at `document_start`, so existing tabs keep the old bundle until refreshed.
3. Popup/options changes need the extension reload plus closing and reopening the popup.
4. The offscreen document is torn down after 5 minutes idle and recreated on demand, so it always picks up a rebuild — but an *already open* one keeps the old code until the extension reload.
