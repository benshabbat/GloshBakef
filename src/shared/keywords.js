/**
 * The text-matching half of the filter. Lives in `shared` rather than in the content
 * script so it can be exercised directly by `npm test` — this is the layer most likely
 * to be subtly wrong, and its failure mode (hiding innocent images) is user-visible.
 */

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Punctuation that routinely separates words inside URLs and filenames becomes a space,
 * so `photo_nude_1.jpg` and `?tag=porn&id=3` both expose their words to the matcher.
 */
export function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[._/?=&+%#-]+/g, " ");
}

/**
 * One regex for the whole keyword list.
 *
 * The letter boundaries are the point. v1 lowercased the text and used `includes()`, so
 * `sexy` matched inside `essexyachts` and `adult` inside `adulteration`. Anchoring on
 * `\p{L}`/`\p{N}` rather than `\b` keeps that fix working for Hebrew keywords too, since
 * `\b` is defined against ASCII word characters only.
 *
 * Keywords are normalized the same way as the text they are matched against. Without
 * that, any keyword containing separator punctuation — `only-fans`, `x.com` — could
 * never fire: the haystack turns those characters into spaces and the keyword does not.
 *
 * Returns null for an empty list, which callers treat as "never matches".
 */
export function compileKeywords(keywords) {
  const usable = [...new Set(keywords.map((word) => normalizeText(word).trim()).filter(Boolean))];
  if (!usable.length) return null;
  const alternatives = usable.map(escapeRegExp).join("|");
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, "iu");
}

export function matchesKeyword(pattern, text) {
  return Boolean(pattern) && pattern.test(normalizeText(text));
}
