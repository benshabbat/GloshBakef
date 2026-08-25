---
name: release
description: Cutting a release and packaging for the Chrome Web Store — version sync, the build gate, exactly what belongs in the ZIP, and the review answers this extension needs ready. Use when asked to bump the version, package, publish, or prepare a store submission.
---

# Releasing

## Version

`manifest.json` and `package.json` both carry the version and both must be bumped together — the manifest is what Chrome and the store read, `package.json` is what a human reads. The store rejects an upload whose version is not strictly greater than the published one, and it never lets a version number be reused, even after a rollback. Bump, do not reuse.

`minimum_chrome_version` is `116`. It exists because of the offscreen and `chrome.scripting` registration APIs this architecture depends on. Lowering it means verifying those APIs on the older target; raising it silently drops users.

## The gate

```
npm run check     # manifest paths, page assets, syntax, then the test suite
npm run build     # minified bundles into dist/
```

`dist/` is gitignored, so **the packaged ZIP cannot come from a clean `git archive`** — the tree must be built first. Confirm both bundles exist and that `build.mjs`'s printed sizes look normal (`dist/content.js` in the KB range, `dist/offscreen.js` around 4.6 MB) before packaging. A build made with `--dev` or `--watch` is unminified with inline sourcemaps — never ship one.

Then load the built tree unpacked one last time and walk the paths in the `test-extension` skill. A store rejection costs days; a reload costs a minute.

## What goes in the ZIP

Include, from the repo root:

- `manifest.json`
- `dist/` — both bundles
- `icons/` — 16/32/48/128
- `src/background/`, `src/shared/`, `src/ui/`, `src/content/*.css`, `src/offscreen/offscreen.html`

Everything under `src/` except the two bundled entry points is **runtime code**, not sources — the worker, the shared module, and the UI pages are loaded raw. They must ship.

Exclude: `node_modules/`, `.git/`, `.claude/`, `scripts/`, `package.json`, `package-lock.json`, `README.md`, and the two bundled entry points' sources if you want a minimal package (harmless either way; shipping readable source is a reasonable choice for a privacy-claiming extension).

The ZIP must contain the manifest at its **root**, not inside a wrapper folder.

## Review answers to have ready

The listing must be able to justify every permission, in these words or better:

| Item | Justification |
| --- | --- |
| `storage` | Saving the user's own filter settings and local counters. |
| `scripting` | Registering the pre-blur stylesheet before first paint, and unregistering it on allowlisted sites. |
| `offscreen` | Hosting the bundled image classifier in a single document instead of in every page. |
| `alarms` | A one-minute tick that closes that document when it has been idle. |
| `host_permissions: <all_urls>` | Reading the bytes of images the page is already loading, locally, so they can be classified. |
| Single purpose | Filtering images the user does not want to see. |
| Data collection | **None.** No analytics, no remote endpoint, no account. The data-usage declaration must say exactly this. |

The remote-code answer matters most: the model is bundled, nothing executable is fetched at runtime, and the only network traffic is image `fetch`es from the offscreen document with `credentials: "omit"`. If that ever stops being true, the listing is wrong before the code is.

Broad host permissions on `<all_urls>` reliably draw a slower review. The justification above is the honest one — the classifier cannot inspect an image it cannot read.

## After publishing

Tag the commit with the same version. Keep the migration branch in `migrate()` for at least one release after any settings rename: users update at their own pace, and `storage.sync` will hand you the old shape from another device long after you have forgotten it.
