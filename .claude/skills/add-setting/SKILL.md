---
name: add-setting
description: End-to-end recipe for adding, renaming, or removing a user setting — the schema, migration, both UI surfaces, every consumer, and the rebuild. Use whenever a new toggle, threshold, list, or per-site option is requested, or when an existing setting changes shape.
---

# Adding a setting

Settings have exactly one home: `SETTINGS` in [src/shared/settings.js](../../../src/shared/settings.js). v1's bug was defaults duplicated across files that drifted apart. Everything below flows from that single object.

## The order to do it in

**1. Declare it.** Add the key to `SETTINGS` with a default and a one-line comment explaining what it means to a user — the comment is what the options-page hint text gets written from. `chrome.storage.sync.get(SETTINGS)` passes the whole object as defaults, so a new key starts working for existing users the moment it is declared.

**2. Sanitize it in `migrate()`.** Storage is not trustworthy: it holds whatever an older version, another device, or a corrupted sync wrote. Numbers get `clamp`ed, arrays get an `Array.isArray` guard, enums fall back to the default. Do this even for a boolean if anything downstream would break on a non-boolean. If the new setting replaces an old one, map the old value across here — `threshold` reading v1's `sensitivity` string is the worked example, and that branch must stay until the migration is no longer worth carrying.

**3. Wire the options page.** [src/ui/options.html](../../../src/ui/options.html) and [options.js](../../../src/ui/options.js), following the existing patterns:
- a plain boolean → add the id to the `TOGGLES` array and add a `.row` with `<label for>`, a `.hint` span, and `aria-describedby` pointing at the hint id;
- anything else → a `.stack` or `.row`, plus explicit `fill()` and listener code;
- textareas and other free text save through `debounce(…)`, never on every keystroke — `storage.sync` allows 120 writes/minute and typing will exceed that;
- ranges update their `<output>` on `input` but only save on `change`.

**4. Wire the popup only if it is a per-visit decision.** [popup.js](../../../src/ui/popup.js) is deliberately small: enabled, this-site allowlisting, the three sensitivity presets, reveal. A setting that a user changes once belongs in options; a setting they reach for on a specific page belongs in the popup. Do not mirror the whole options page into it.

**5. Consume it.** The content script reads `state.settings` after `applySettings`; the worker reads through `getSettings()`. Both are refreshed by `onSettingsChanged`, so a change takes effect live — but only if the code path actually re-reads. If the setting affects verdicts, confirm that changing it invalidates existing ones (`applySettings` resets every tagged element when the filter is already active).

**6. Check the worker side.** If the setting changes *what the worker registers or caches*, add it to `syncPreblur` (like `hideUntilChecked` and `allowlist`) or account for it where the score cache is read. The cache stores raw class vectors precisely so that threshold-like settings need no invalidation — keep new scoring settings on that side of the line rather than baking verdicts into the cache.

**7. Rebuild.** `src/shared/` is compiled into both bundles *and* loaded raw by the worker and UI. Skipping `npm run build` leaves the two halves of the extension disagreeing, silently. Then `npm run check`.

**8. Test it live.** Open a page, change the setting in the options tab, and watch the page react without a reload. That round trip — options page → `storage.sync` → `onChanged` → every frame and the worker — is the whole point of the architecture and the thing most likely to be miswired.

## Choosing the storage area

`sync` for anything the user set on purpose; `local` for anything the extension derived (counters, caches). `STATS` is the existing `local` example. Watch the 8 KB per-item cap for lists — `keywords` and `allowlist` are each one item.

## Removing or renaming

Deleting a key from `SETTINGS` does not delete it from users' storage; the stale value sits in `sync` forever, still counting against quota. Renaming means reading the old key in `migrate()` for at least one release. Removing a setting also means removing its `excludeMatches`/registration effects in `syncPreblur`, or a dynamic content script can outlive the setting that created it.
