/**
 * Single source of truth for the extension settings.
 * Imported by the content script, the service worker, the popup and the options page,
 * so the defaults can never drift between them.
 */

export const SENSITIVITY_PRESETS = {
  relaxed: 0.85,
  balanced: 0.7,
  strict: 0.5
};

export const DEFAULT_KEYWORDS = [
  "nsfw", "nude", "nudity", "lingerie", "bikini", "swimwear",
  "explicit", "adult", "sexy", "porn", "erotic", "onlyfans"
];

/** Synced across the user's Chrome profiles. */
export const SETTINGS = {
  enabled: true,
  /** Model score (0-1) at or above which an image is hidden. */
  threshold: SENSITIVITY_PRESETS.balanced,
  keywords: DEFAULT_KEYWORDS,
  /** Run the local neural model, not just the keyword heuristic. */
  analyzeContent: true,
  /** Inspect the frames a video actually shows, not only its poster still. */
  analyzeVideos: true,
  /** Seconds between two checks of the same video while it plays on screen. */
  videoSampleSeconds: 5,
  /** Pause and mute a hidden video, so its soundtrack does not play on behind the blur. */
  pauseBlockedVideos: true,
  /** Count the model's "Sexy" class (swimwear, lingerie) towards the risk score. */
  includeSuggestive: true,
  /** Blur every image from the first paint until it has been cleared. */
  hideUntilChecked: true,
  /** Let the user click a hidden image to reveal it for the rest of the visit. */
  clickToReveal: true,
  /** Rendered images smaller than this (px, either axis) are treated as UI chrome. */
  minImageSize: 96,
  /** Also inspect CSS `background-image` layers. Costlier, so off by default. */
  scanBackgrounds: false,
  /** Hostnames the filter never touches. */
  allowlist: []
};

/** Kept in storage.local: counters are noisy and profile-specific. */
export const STATS = {
  blockedTotal: 0,
  analyzedTotal: 0
};

/**
 * The accepted range of every numeric setting, in one place. `migrate` clamps to it and
 * the options page drives its own inputs from it, so a bound can never be widened in the
 * UI without the store agreeing — or narrowed in the store without the UI following.
 */
export const BOUNDS = {
  threshold: [0.2, 0.95],
  minImageSize: [0, 1000],
  videoSampleSeconds: [1, 60]
};

const HOST_PATTERN = /^[a-z0-9.-]+$/;

export async function readSettings() {
  const stored = await chrome.storage.sync.get(SETTINGS);
  return migrate(stored);
}

export function writeSettings(patch) {
  return chrome.storage.sync.set(patch);
}

export async function readStats() {
  return chrome.storage.local.get(STATS);
}

/**
 * v1 stored `sensitivity: "strict" | "balanced"`. Map it onto the numeric threshold
 * so upgrading users keep the strictness they chose.
 *
 * Everything that comes out of storage is treated as untrusted: it is synced across
 * profiles and written by whichever version of the extension got there first. The list
 * fields are re-parsed entry by entry rather than merely type-checked — a single unusable
 * hostname is enough to make `toMatchPattern` produce an invalid match pattern, which
 * makes the whole pre-blur registration fail and silently disables "hide until checked".
 */
export function migrate(stored) {
  const settings = { ...SETTINGS, ...stored };
  if (stored.sensitivity && stored.threshold === undefined) {
    settings.threshold = SENSITIVITY_PRESETS[stored.sensitivity] ?? SETTINGS.threshold;
  }
  settings.threshold = clampTo("threshold", Number(settings.threshold) || SETTINGS.threshold);
  settings.minImageSize = clampTo("minImageSize", Math.round(Number(settings.minImageSize) || 0));
  // A zero here would busy-loop the sampler, so it falls back to the default rather than to 0.
  settings.videoSampleSeconds = clampTo(
    "videoSampleSeconds",
    Math.round(Number(settings.videoSampleSeconds) || SETTINGS.videoSampleSeconds)
  );
  settings.keywords = sanitizeList(settings.keywords, normalizeKeyword);
  settings.allowlist = sanitizeList(settings.allowlist, parseHostname);
  return settings;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampTo(field, value) {
  return clamp(value, ...BOUNDS[field]);
}

/**
 * The five nsfwjs classes come out of a softmax, so the probability that an image is
 * unsafe is the sum of the unsafe classes — not the max of them, which v1 used and which
 * under-detects whenever confidence is split between "Porn" and "Hentai".
 */
export function riskScore(classes, settings) {
  if (!classes) return -1;
  const suggestive = settings.includeSuggestive ? classes.Sexy || 0 : 0;
  return clamp((classes.Porn || 0) + (classes.Hentai || 0) + suggestive, 0, 1);
}

/** Notifies `listener` with the full, migrated settings object on every change. */
export function onSettingsChanged(listener) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    readSettings().then(listener);
  });
}

/**
 * Split on commas and newlines, run every entry through `normalize`, drop what it
 * rejects and de-duplicate. The keyword box, the allowlist box and `migrate` all want
 * exactly this and differ only in the normalizer.
 */
export function parseList(text, normalize) {
  return sanitizeList(String(text ?? "").split(/[,\n]/), normalize);
}

/** The array form of `parseList`, for values that are already a list. */
function sanitizeList(list, normalize) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map(normalize).filter(Boolean))];
}

function normalizeKeyword(word) {
  return String(word ?? "").trim().toLowerCase();
}

export function parseKeywords(text) {
  return parseList(text, normalizeKeyword);
}

export function parseHostnames(text) {
  return parseList(text, parseHostname);
}

export function parseHostname(input) {
  const trimmed = String(input || "").trim().toLowerCase();
  if (!trimmed) return "";
  try {
    // Accepts "example.com", "https://example.com/x" and "www.example.com".
    const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
    // chrome://, file:// and friends are never filtered, so they can never be allowlisted.
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return HOST_PATTERN.test(url.hostname) ? url.hostname : "";
  } catch {
    return "";
  }
}

/** `example.com` in the allowlist also covers `www.example.com` and `img.example.com`. */
export function isAllowlisted(allowlist, hostname) {
  if (!hostname) return false;
  return allowlist.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`));
}

export function toMatchPattern(hostname) {
  return [`*://${hostname}/*`, `*://*.${hostname}/*`];
}
