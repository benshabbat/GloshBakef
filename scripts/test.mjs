/**
 * Tests for the parts of the filter that are pure logic — keyword matching, risk
 * scoring, the allowlist and settings migration. Everything else needs a real browser
 * (see the `test-extension` skill).
 *
 * Run with `npm test`. No framework: this must stay runnable on a bare Node install.
 */
import {
  riskScore,
  isAllowlisted,
  parseHostname,
  parseHostnames,
  parseKeywords,
  toMatchPattern,
  migrate,
  BOUNDS,
  SETTINGS,
  SENSITIVITY_PRESETS,
  DEFAULT_KEYWORDS
} from "../src/shared/settings.js";
import { compileKeywords, matchesKeyword, normalizeText } from "../src/shared/keywords.js";
import { isFetchableUrl } from "../src/shared/urls.js";
import { isFromExtensionPage } from "../src/shared/messages.js";

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed += 1;
  else failures.push(`${name}\n      actual   ${JSON.stringify(actual)}\n      expected ${JSON.stringify(expected)}`);
}

function group(name) {
  console.log(`\n  ${name}`);
}

/* ------------------------------------------------------------------- keywords */

group("keyword matching");
const pattern = compileKeywords(DEFAULT_KEYWORDS);
const hits = (text) => matchesKeyword(pattern, text);

check("matches in a filename", hits("https://cdn.example.com/nsfw-photo.jpg"), true);
check("matches across underscores", hits("photo_nude_1.jpg"), true);
check("matches in a query string", hits("/img?tag=porn&id=3"), true);
check("matches case-insensitively", hits("/PORN/x.png"), true);
check("matches a plain word in alt text", hits("art nudity study"), true);
check("matches a hyphenated keyword", hits("summer-bikini-sale.jpg"), true);

// The whole point of the word-boundary regex: v1's substring match hid all three.
check("does not match inside essexyachts", hits("https://essexyachts.com/boat.jpg"), false);
check("does not match inside middlesex", hits("middlesex-council.png"), false);
check("does not match inside adulteration", hits("food-adulteration-report.png"), false);
check("leaves an ordinary news URL alone", hits("https://bbc.com/news/world-12345"), false);

check("empty keyword list never matches", matchesKeyword(compileKeywords([]), "porn"), false);
check("regex metacharacters are escaped", matchesKeyword(compileKeywords(["a.c"]), "abc"), false);

// A keyword carrying separator punctuation has to be normalized like the haystack is,
// or it can never fire — the text side turns `-` and `.` into spaces and it would not.
check("hyphenated keyword matches its own form", matchesKeyword(compileKeywords(["only-fans"]), "join only-fans now"), true);
check("hyphenated keyword matches a URL form", matchesKeyword(compileKeywords(["only-fans"]), "https://cdn.x/only_fans/1.jpg"), true);
check("dotted keyword matches", matchesKeyword(compileKeywords(["x.com"]), "from x.com/photo"), true);
check("keyword normalization does not over-match", matchesKeyword(compileKeywords(["only-fans"]), "onlyfansite"), false);
check("hebrew keyword matches", matchesKeyword(compileKeywords(["עירום"]), "תמונת עירום"), true);
check("hebrew keyword respects boundaries", matchesKeyword(compileKeywords(["עירום"]), "מעירומים"), false);
check("normalizes separators to spaces", normalizeText("a_b.c/d?e=f"), "a b c d e f");

/* ------------------------------------------------------------------ risk score */

group("risk score");
const split = { Porn: 0.4, Hentai: 0.35, Sexy: 0.05, Neutral: 0.2, Drawing: 0 };

check("sums the unsafe classes", Number(riskScore(split, { includeSuggestive: true }).toFixed(2)), 0.8);
// The regression this replaced: max() leaves split confidence under every preset.
check("v1's max() would have missed it", Math.max(split.Porn, split.Hentai, split.Sexy) >= SENSITIVITY_PRESETS.balanced, false);
check("sum crosses the balanced preset", riskScore(split, { includeSuggestive: true }) >= SENSITIVITY_PRESETS.balanced, true);

check("suggestive off drops Sexy", Number(riskScore({ Porn: 0.1, Sexy: 0.8 }, { includeSuggestive: false }).toFixed(2)), 0.1);
check("suggestive on counts Sexy", Number(riskScore({ Porn: 0.1, Sexy: 0.8 }, { includeSuggestive: true }).toFixed(2)), 0.9);
check("clamps to 1", riskScore({ Porn: 0.9, Hentai: 0.9, Sexy: 0.9 }, { includeSuggestive: true }), 1);
check("missing classes count as zero", riskScore({ Neutral: 1 }, { includeSuggestive: true }), 0);

// Fail-open is load-bearing: an unreadable image must never cross any threshold.
check("null classes score -1", riskScore(null, { includeSuggestive: true }), -1);
for (const [name, threshold] of Object.entries(SENSITIVITY_PRESETS)) {
  check(`-1 never blocks at ${name}`, -1 >= threshold, false);
}

/* ------------------------------------------------------------------- allowlist */

group("allowlist");
check("exact hostname", isAllowlisted(["example.com"], "example.com"), true);
check("www subdomain", isAllowlisted(["example.com"], "www.example.com"), true);
check("deep subdomain", isAllowlisted(["example.com"], "img.cdn.example.com"), true);
check("does not match a suffix lookalike", isAllowlisted(["example.com"], "notexample.com"), false);
check("empty hostname is never allowlisted", isAllowlisted(["example.com"], ""), false);
check("empty allowlist allows nothing", isAllowlisted([], "example.com"), false);
check("builds both match patterns", toMatchPattern("example.com"), ["*://example.com/*", "*://*.example.com/*"]);

/* ------------------------------------------------------------------- hostnames */

group("hostname parsing");
check("bare hostname", parseHostname("example.com"), "example.com");
check("full URL", parseHostname("https://www.example.com/a/b?c=1"), "www.example.com");
check("uppercase is normalized", parseHostname("HTTPS://Example.COM"), "example.com");
check("chrome:// is rejected", parseHostname("chrome://extensions"), "");
check("file:// is rejected", parseHostname("file:///C:/x.html"), "");
check("junk is rejected", parseHostname("!!!"), "");
check("empty input is rejected", parseHostname(""), "");

/* -------------------------------------------------------------------- settings */

group("settings");
check("trims, lowercases and dedupes keywords", parseKeywords("a, b ,a\nC"), ["a", "b", "c"]);
check("drops empty entries", parseKeywords("a,,  ,b"), ["a", "b"]);

check("v1 strict maps to a threshold", migrate({ sensitivity: "strict" }).threshold, SENSITIVITY_PRESETS.strict);
check("v1 balanced maps to a threshold", migrate({ sensitivity: "balanced" }).threshold, SENSITIVITY_PRESETS.balanced);
check("an explicit threshold wins over v1", migrate({ sensitivity: "strict", threshold: 0.9 }).threshold, 0.9);
check("out-of-range threshold is clamped", migrate({ threshold: 99 }).threshold, BOUNDS.threshold[1]);
check("a below-range threshold is clamped", migrate({ threshold: 0 }).threshold, SETTINGS.threshold);
check("the slider's range is the stored range", BOUNDS.threshold, [0.2, 0.95]);
check("garbage threshold falls back", migrate({ threshold: "nope" }).threshold, SENSITIVITY_PRESETS.balanced);
check("non-array keywords are replaced", migrate({ keywords: "porn" }).keywords, []);
check("defaults survive an empty store", migrate({}).keywords, DEFAULT_KEYWORDS);

// Storage is synced across profiles and written by whichever version got there first, so
// migrate has to sanitize entry by entry — not just check the type of the list.
check("stored keywords are normalized", migrate({ keywords: [" NSFW ", "nsfw", ""] }).keywords, ["nsfw"]);
check("stored keywords drop non-strings", migrate({ keywords: ["ok", null, 7] }).keywords, ["ok", "7"]);
check("stored allowlist is normalized", migrate({ allowlist: ["HTTPS://Example.com/x"] }).allowlist, ["example.com"]);
// The one that matters: an empty entry makes toMatchPattern emit `*:///*`, which Chrome
// rejects — taking the whole pre-blur registration down with it, silently.
check("an unusable allowlist entry is dropped", migrate({ allowlist: ["", "example.com", "!!"] }).allowlist, ["example.com"]);
check("allowlist entries are deduped", migrate({ allowlist: ["a.com", "www.A.com/", "a.com"] }).allowlist, ["a.com", "www.a.com"]);
check("parses an allowlist textarea", parseHostnames("example.com\nhttps://b.org/x, !!\n"), ["example.com", "b.org"]);

/* ---------------------------------------------------------------- fetchable URLs */

group("fetchable urls");
check("an ordinary image URL is fetchable", isFetchableUrl("https://cdn.example.com/a.jpg"), true);
check("plain http is fetchable", isFetchableUrl("http://example.com/a.jpg"), true);
check("a data URL carries its own bytes", isFetchableUrl("data:image/png;base64,iVBOR"), true);

// The extension fetches with host permissions, so it is not bound by the CORS and
// Private Network Access rules that stop the page itself reaching these.
check("localhost is refused", isFetchableUrl("http://localhost:3000/a.png"), false);
check("loopback is refused", isFetchableUrl("http://127.0.0.1/a.png"), false);
check("decimal loopback is refused", isFetchableUrl("http://2130706433/a.png"), false);
check("a LAN address is refused", isFetchableUrl("http://192.168.1.1/logo.png"), false);
check("a 10/8 address is refused", isFetchableUrl("http://10.0.0.5/a.png"), false);
check("a 172.16/12 address is refused", isFetchableUrl("http://172.20.0.1/a.png"), false);
check("172.32 is public and stays fetchable", isFetchableUrl("http://172.32.0.1/a.png"), true);
check("link-local is refused", isFetchableUrl("http://169.254.169.254/latest/meta-data"), false);
check("a .local name is refused", isFetchableUrl("http://printer.local/a.png"), false);
check("IPv6 loopback is refused", isFetchableUrl("http://[::1]/a.png"), false);
check("IPv6 unique-local is refused", isFetchableUrl("http://[fd00::1]/a.png"), false);
check("a public IPv6 address stays fetchable", isFetchableUrl("http://[2606:4700::1]/a.png"), true);

check("blob URLs are never fetched here", isFetchableUrl("blob:https://example.com/abc"), false);
check("file URLs are refused", isFetchableUrl("file:///C:/x.png"), false);
check("junk is refused", isFetchableUrl("not a url"), false);

/* ---------------------------------------------------------------------- videos */

group("video settings");
check("frame sampling is on by default", migrate({}).analyzeVideos, true);
check("hidden videos pause by default", migrate({}).pauseBlockedVideos, true);
check("sample interval default", migrate({}).videoSampleSeconds, SETTINGS.videoSampleSeconds);
check("an explicit interval is kept", migrate({ videoSampleSeconds: 12 }).videoSampleSeconds, 12);
check("a fractional interval is rounded", migrate({ videoSampleSeconds: 2.6 }).videoSampleSeconds, 3);
check("an over-long interval is clamped", migrate({ videoSampleSeconds: 999 }).videoSampleSeconds, 60);
// Zero would turn the sampler into a busy loop, so it must never survive migration.
check("zero falls back to the default", migrate({ videoSampleSeconds: 0 }).videoSampleSeconds, SETTINGS.videoSampleSeconds);
check("a negative interval is clamped", migrate({ videoSampleSeconds: -5 }).videoSampleSeconds, 1);
check("garbage falls back to the default", migrate({ videoSampleSeconds: "soon" }).videoSampleSeconds, SETTINGS.videoSampleSeconds);
check("an upgrading user keeps video checks on", migrate({ sensitivity: "strict" }).analyzeVideos, true);

/* ------------------------------------------------------------- message senders */

group("message senders");
const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";
const from = (sender) => isFromExtensionPage(sender, ORIGIN);

// The options page IS a tab. `sender.tab` was used as the guard here once and rejected it,
// which made the self-test report "no answer" while the worker was perfectly healthy.
check("the options page is accepted", from({ url: `${ORIGIN}src/ui/options.html`, tab: { id: 7 } }), true);
check("the popup is accepted", from({ url: `${ORIGIN}src/ui/popup.html` }), true);
check("the offscreen document is accepted", from({ url: `${ORIGIN}src/offscreen/offscreen.html` }), true);

// A content script carries the host page's URL, whatever the page pretends to be.
check("a content script is refused", from({ url: "https://example.com/a", tab: { id: 3 } }), false);
check("a lookalike host is refused", from({ url: "https://chrome-extension.example.com/x" }), false);
// A page cannot spell its way in: the origin has a trailing slash, so a prefix that only
// shares the extension id but continues into another host cannot match.
check("an origin-prefix lookalike is refused", from({ url: `${ORIGIN.slice(0, -1)}.evil.com/x` }), false);
check("a sender with no url is refused", from({ tab: { id: 3 } }), false);
check("an empty sender is refused", from({}), false);
check("a missing sender is refused", from(undefined), false);
check("an unknown extension origin is refused", isFromExtensionPage({ url: `${ORIGIN}x` }, ""), false);

/* ---------------------------------------------------------------------- report */

if (failures.length) {
  console.error(`\n${failures.length} failed:\n`);
  for (const failure of failures) console.error(`  - ${failure}\n`);
  process.exit(1);
}
console.log(`\n  ${passed} assertions passed\n`);
