---
name: rtl-ui
description: Hebrew, RTL and accessibility conventions for this extension's surfaces — the popup, the options page, manifest strings, and the labels the content script writes onto pages. Use when adding or editing any user-visible text, control, or page.
---

# Hebrew / RTL / a11y conventions

## Language split

- **User-visible → Hebrew**: manifest `name`/`description`, page titles, headings, labels, hints, button text, status messages, the `aria-label` written onto hidden images, and the README.
- **Developer-visible → English**: identifiers, function names, comments, commit messages, `.claude/` content.

Do not mix. A Hebrew comment or an English button label both read as accidents.

## Pages

`popup.html` and `options.html` both open `<html lang="he" dir="rtl">` with `<meta charset="utf-8">`, load `ui.css` then their own stylesheet, and end with `<script type="module" src="…">`. The module type is required — both scripts import from `../shared/settings.js`. A new page must follow all four.

The offscreen page is `lang="he"` but has no `dir` and no UI at all; it is invisible infrastructure. Do not add anything user-facing to it.

## CSS

Logical properties only, so layout follows `dir` instead of fighting it:

- `margin-inline-start` / `-end`, `padding-inline`, `inset-inline-start`, `border-inline-start`
- `text-align: start` / `end`

Physical `left`/`right` is correct only for something genuinely direction-independent.

## Mixed-direction text

Latin runs inside Hebrew — hostnames, keywords like `nsfw`, `example.com`, code — reorder unpredictably at the boundaries. Wrap inline occurrences in `<code>` (as the options hints already do) or `<bdi>`. The `keywords` and `allowlist` textareas hold Latin content inside an RTL page and carry `spellcheck="false"`; check how a list actually renders before forcing a direction on them.

Numbers in sentences go through `toLocaleString("he-IL")`, as the stats line does.

## Accessibility patterns already in use — keep them

- **Status regions.** `#status` in the options page is `role="status" aria-live="polite"`, revealed via a `data-visible` attribute and auto-hidden after ~1.6 s. The popup's `#tab-summary` is `role="status"`. New transient feedback goes through `announce()`, not a fresh element.
- **Hints.** Every non-obvious control has a `.hint` span with an id, referenced by `aria-describedby` on the input. A new setting gets the same treatment — the hint is the only explanation a user gets.
- **Labels.** Every input has a `<label for>`; section headings that label a control wrap it (`<h2><label for="keywords">`). No placeholder-only fields.
- **Segmented control.** The popup's sensitivity buttons are a `role="group"` with `aria-labelledby`, and selection is expressed as `aria-pressed` on each button — not a class. Update `aria-pressed` for every button on every render, including the false ones.
- **Range.** `<input type="range">` paired with `<output for>`, and a decorative `aria-hidden="true"` scale beneath it.
- **Disabled state.** The popup disables the per-site toggle and says why in `#hostname` ("לא ניתן לסנן את הדף הזה") rather than leaving a dead control unexplained.

## Labels the content script writes

Hiding an image overwrites its `title` and `aria-label` with Hebrew text, so a screen-reader user is told the filter acted rather than hearing the page's own description of hidden content. The page's originals are stashed in a `WeakMap` first and restored on reveal, teardown, or allowlisting. **Never overwrite a page attribute without saving it first** — the restore path is part of the feature, not cleanup.

`content.css` honors `prefers-reduced-motion` by dropping the blur transition. Any new animation on page content needs the same guard.
