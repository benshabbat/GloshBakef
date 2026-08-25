import { readSettings, onSettingsChanged, isAllowlisted } from "../shared/settings.js";
import { compileKeywords, normalizeText, matchesKeyword } from "../shared/keywords.js";
import { MSG, UNKNOWN_SCORE } from "../shared/messages.js";

const ATTR = "data-imgfilter";
const BG_ATTR = "data-imgfilter-bg";
const OFF_ATTR = "data-imgfilter-off";
const SNAPSHOT_SIZE = 224; // matches the model input, so the worker never resizes twice.
const VIEWPORT_MARGIN = "400px";
/** `HTMLMediaElement.HAVE_CURRENT_DATA` — the first readyState with a drawable frame. */
const HAVE_CURRENT_DATA = 2;
/** Floor between two looks at the same video, so scrubbing cannot spam the model. */
const MIN_SAMPLE_GAP_MS = 800;
/** Give up re-checking a video after this many unreadable looks in a row (DRM, tainted). */
const MAX_VIDEO_MISSES = 3;

const LABELS = {
  image: { hidden: "תמונה הוסתרה על ידי מסנן התמונות", reveal: "לחיצה תחשוף אותה." },
  video: { hidden: "סרטון הוסתר על ידי מסנן התמונות", reveal: "לחיצה תחשוף אותו." }
};

const state = {
  settings: null,
  keywordPattern: null,
  active: false,
  blocked: 0
};

/** element -> { src, status, sampledAt, misses } for every element we have looked at. */
const records = new WeakMap();
const pendingLoad = new WeakSet();
/** element -> the page's own title/aria-label, so hiding an image never destroys them. */
const originalLabels = new WeakMap();
/** video -> { muted, paused } as the page left it, before we silenced it. */
const originalPlayback = new WeakMap();
/** Videos already carrying our playback listeners. */
const watchedVideos = new WeakSet();
/** Cleared videos that are on screen, and so still worth re-checking as they play. */
const liveVideos = new Set();

let viewportObserver;
let domObserver;
let reportTimer;
let backgroundScanTimer;
let videoTimer;

/* ------------------------------------------------------------------ helpers */

function isVideo(node) {
  return node instanceof HTMLVideoElement;
}

function isMedia(node) {
  return node instanceof HTMLImageElement || isVideo(node);
}

/**
 * The element's effective source, used both as its identity and as the URL the worker
 * fetches. For a video that is the movie itself; its poster is a separate still and is
 * only the fallback, because the poster is what the publisher chose to show and the
 * frames are what the page actually plays.
 */
function sourceOf(element) {
  const src = element.currentSrc || element.getAttribute("src") || "";
  if (src) return src;
  return isVideo(element) ? element.poster || "" : "";
}

function posterOf(element) {
  return isVideo(element) ? element.poster || "" : "";
}

function textAround(element) {
  return [
    element.alt,
    element.title,
    element.getAttribute("aria-label"),
    sourceOf(element),
    posterOf(element),
    element.closest("a")?.href
  ].join(" ");
}

function hasBlockedKeyword(element) {
  return matchesKeyword(state.keywordPattern, textAround(element));
}

/** Intrinsic size, when the browser already knows it. */
function intrinsicSize(element) {
  if (isVideo(element)) return Math.max(element.videoWidth || 0, element.videoHeight || 0);
  return Math.max(element.naturalWidth || 0, element.naturalHeight || 0);
}

function renderedSize(element) {
  const rect = element.getBoundingClientRect();
  return Math.max(rect.width, rect.height);
}

/* ------------------------------------------------------------- applying a verdict */

function mark(element, status) {
  const record = records.get(element);
  if (record) record.status = status;
  element.setAttribute(ATTR, status);
}

function block(element) {
  if (records.get(element)?.status === "blocked") return;
  mark(element, "blocked");
  if (!originalLabels.has(element)) {
    originalLabels.set(element, {
      title: element.getAttribute("title"),
      ariaLabel: element.getAttribute("aria-label")
    });
  }
  const label = isVideo(element) ? LABELS.video : LABELS.image;
  element.setAttribute("aria-label", label.hidden);
  element.setAttribute(
    "title",
    state.settings.clickToReveal ? `${label.hidden}. ${label.reveal}` : `${label.hidden}.`
  );
  if (isVideo(element)) silence(element);
  state.blocked += 1;
  scheduleReport();
}

/** Puts back whatever the page had on the element before we hid it. */
function restoreLabels(element) {
  const original = originalLabels.get(element);
  if (!original) return;
  originalLabels.delete(element);
  for (const [attribute, value] of [["title", original.title], ["aria-label", original.ariaLabel]]) {
    if (value === null) element.removeAttribute(attribute);
    else element.setAttribute(attribute, value);
  }
}

/**
 * A blur says nothing about a soundtrack, so a hidden video is paused and muted too.
 * The page's own playback state is stashed first and restored the moment it is revealed.
 */
function silence(element) {
  liveVideos.delete(element); // a blocked video stays blocked until the user says otherwise
  if (!state.settings.pauseBlockedVideos) return;
  if (!originalPlayback.has(element)) {
    originalPlayback.set(element, { muted: element.muted, paused: element.paused });
  }
  element.muted = true;
  element.pause();
}

function restorePlayback(element) {
  const original = originalPlayback.get(element);
  if (!original) return;
  originalPlayback.delete(element);
  element.muted = original.muted;
  // Autoplay policy can refuse this outside a user gesture; the frame is visible either way.
  if (!original.paused) element.play().catch(() => {});
}

function unblock(element, status) {
  if (records.get(element)?.status === "blocked") {
    state.blocked = Math.max(0, state.blocked - 1);
    scheduleReport();
  }
  restoreLabels(element);
  restorePlayback(element);
  mark(element, status);
}

function allow(element) {
  unblock(element, "safe");
}

function reset(element) {
  if (records.get(element)?.status === "blocked") state.blocked = Math.max(0, state.blocked - 1);
  restoreLabels(element);
  restorePlayback(element);
  records.delete(element);
  element.removeAttribute(ATTR);
  viewportObserver?.unobserve(element);
  liveVideos.delete(element);
}

/* ------------------------------------------------------------- the state machine */

function evaluate(element) {
  if (!state.active || !isMedia(element)) return;

  const src = sourceOf(element);
  const record = records.get(element);

  // Re-run only when the effective source actually changed (SPAs swap src constantly).
  if (record && record.src === src && record.status !== "pending") return;
  if (!record || record.src !== src) {
    records.set(element, { src, status: "pending", sampledAt: 0, misses: 0 });
  }

  if (hasBlockedKeyword(element)) {
    block(element);
    return;
  }

  // A video legitimately has no src of its own — MSE and <source> children both leave it
  // empty — so an empty source is only a reason to wait for an <img>.
  if (!src && !isVideo(element)) {
    mark(element, "pending");
    waitForLoad(element);
    return;
  }

  const intrinsic = intrinsicSize(element);
  if (intrinsic > 0 && intrinsic < state.settings.minImageSize) {
    allow(element);
    return;
  }

  if (!state.settings.analyzeContent) {
    allow(element);
    return;
  }

  if (isVideo(element)) {
    evaluateVideo(element);
    return;
  }

  // Not decoded yet: the browser does not know the size and the bytes may not be cached.
  if (!element.complete) {
    mark(element, "pending");
    waitForLoad(element);
    return;
  }

  mark(element, "pending");
  viewportObserver.observe(element);
}

function evaluateVideo(element) {
  watchVideo(element);

  const framesReadable = state.settings.analyzeVideos && element.readyState >= HAVE_CURRENT_DATA;
  if (!framesReadable && !element.poster) {
    // Nothing to look at: with frame sampling off and no poster there never will be, so
    // fail open rather than leaving the element blurred forever.
    if (!state.settings.analyzeVideos) {
      allow(element);
      return;
    }
    mark(element, "pending");
    waitForLoad(element);
    return;
  }

  mark(element, "pending");
  viewportObserver.observe(element);
}

/** `loadeddata` rather than `loadedmetadata`: metadata gives a size, not a drawable frame. */
const LOAD_EVENTS = ["load", "loadeddata"];

function waitForLoad(element) {
  if (pendingLoad.has(element)) return;
  pendingLoad.add(element);
  const detach = () => {
    pendingLoad.delete(element);
    for (const name of LOAD_EVENTS) element.removeEventListener(name, done);
    element.removeEventListener("error", failed);
  };
  const done = () => {
    detach();
    const record = records.get(element);
    if (record) record.src = null; // force a fresh evaluation
    evaluate(element);
  };
  const failed = () => {
    detach();
    allow(element); // a broken image cannot show anything
  };
  for (const name of LOAD_EVENTS) element.addEventListener(name, done);
  element.addEventListener("error", failed);
}

function onVisible(entries) {
  for (const entry of entries) {
    const element = entry.target;

    if (!entry.isIntersecting) {
      // Only videos stay observed past their first appearance, and only so that scrolling
      // one out of sight stops its sampling loop.
      liveVideos.delete(element);
      continue;
    }

    const status = records.get(element)?.status;

    if (isVideo(element)) {
      // Back on screen after being cleared: put it under review again.
      if (status === "safe") keepWatching(element);
    } else {
      viewportObserver.unobserve(element);
    }

    if (status !== "pending") continue;

    const rendered = renderedSize(element);
    if (rendered > 0 && rendered < state.settings.minImageSize) {
      allow(element);
      continue;
    }
    score(element);
  }
}

/* ---------------------------------------------------------------- classification */

async function requestScore(payload) {
  try {
    const result = await chrome.runtime.sendMessage({ type: MSG.SCORE, ...payload });
    return result ?? { score: UNKNOWN_SCORE };
  } catch {
    // The worker can be torn down mid-flight; failing open beats blurring the page forever.
    return { score: UNKNOWN_SCORE };
  }
}

async function score(element) {
  if (isVideo(element)) {
    await scoreVideo(element);
    return;
  }

  const src = sourceOf(element);
  if (!src) {
    allow(element);
    return;
  }

  // blob: URLs only resolve inside this page, so go straight to the pixel path.
  let result = src.startsWith("blob:")
    ? { score: UNKNOWN_SCORE, needsPixels: true }
    : await requestScore({ url: src });

  if (result.needsPixels) {
    const dataUrl = snapshot(element);
    result = dataUrl ? await requestScore({ url: src, dataUrl }) : { score: UNKNOWN_SCORE };
  }

  if (!state.active || records.get(element)?.src !== src) return;

  if ((result.score ?? UNKNOWN_SCORE) >= state.settings.threshold) block(element);
  else allow(element);
}

/**
 * A video is a moving target: the poster is a still someone picked, and the content keeps
 * changing as it plays. So it is judged on its own frames, and re-judged while it runs.
 */
async function scoreVideo(element) {
  const src = sourceOf(element);
  const value = await sampleVideo(element);

  if (!state.active || records.get(element)?.src !== src) return;

  if (value >= state.settings.threshold) {
    block(element);
    return;
  }
  allow(element);
  if (countMiss(element, value)) keepWatching(element);
}

/**
 * Tracks how many looks in a row came back unreadable. A DRM-protected or tainted video
 * never becomes readable, and re-asking every few seconds forever is pure waste — but one
 * failed round-trip to a sleeping worker is not a reason to stop either.
 * Returns whether this video is still worth re-checking.
 */
function countMiss(element, value) {
  const record = records.get(element);
  if (!record) return false;
  record.misses = value === UNKNOWN_SCORE ? record.misses + 1 : 0;
  if (record.misses < MAX_VIDEO_MISSES) return true;
  liveVideos.delete(element);
  return false;
}

/** One look at a video: the frame it is showing now, or its poster if it has no readable one. */
async function sampleVideo(element) {
  const record = records.get(element);
  if (record) record.sampledAt = Date.now();

  if (state.settings.analyzeVideos && element.readyState >= HAVE_CURRENT_DATA) {
    const dataUrl = snapshot(element);
    // Frames are never cached: the next one is a different picture under the same URL.
    if (dataUrl) {
      const result = await requestScore({ url: sourceOf(element), dataUrl, cache: false });
      return result.score ?? UNKNOWN_SCORE;
    }
    // No frame came back — DRM, or a cross-origin video that taints the canvas. The poster
    // below is the only thing left to go on.
  }

  const poster = posterOf(element);
  if (!poster) return UNKNOWN_SCORE;

  const result = await requestScore({ url: poster });
  // The poster's own bytes are unreachable from here: drawing the element would give a
  // video frame, not the poster, so there is no pixel fallback for this one.
  return result.needsPixels ? UNKNOWN_SCORE : result.score ?? UNKNOWN_SCORE;
}

/**
 * Draws the already-decoded element into a small canvas. Works for same-origin,
 * CORS-clean, `blob:` and `data:` images and videos — including the MSE streams the big
 * video sites use — and throws for tainted ones, which we treat as "cannot inspect".
 */
function snapshot(element) {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = SNAPSHOT_SIZE;
    canvas.height = SNAPSHOT_SIZE;
    const context = canvas.getContext("2d", { willReadFrequently: false });
    context.drawImage(element, 0, 0, SNAPSHOT_SIZE, SNAPSHOT_SIZE);
    return canvas.toDataURL("image/jpeg", 0.75);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- the video sampler */

/** One-time playback listeners: these events change the picture without touching an attribute. */
function watchVideo(element) {
  if (watchedVideos.has(element)) return;
  watchedVideos.add(element);
  element.addEventListener("play", () => {
    scheduleVideoPass(); // the loop stops itself while everything is paused
    resample(element);
  });
  element.addEventListener("seeked", () => resample(element));
  // MSE and <source> swaps replace the movie while every attribute stays as it was.
  element.addEventListener("emptied", () => {
    const record = records.get(element);
    if (record) record.src = null;
    evaluate(element);
  });
}

/** Keeps a cleared video under review for as long as it is on screen. */
function keepWatching(element) {
  if (!state.active || !state.settings.analyzeVideos) return;
  liveVideos.add(element);
  scheduleVideoPass();
}

function scheduleVideoPass() {
  if (videoTimer || !state.active || !liveVideos.size) return;
  videoTimer = setTimeout(videoPass, state.settings.videoSampleSeconds * 1000);
}

function videoPass() {
  videoTimer = null;
  let playing = false;
  for (const element of [...liveVideos]) {
    if (!element.isConnected) {
      liveVideos.delete(element);
      continue;
    }
    if (element.paused || element.ended) continue; // nothing new since the last look
    playing = true;
    resample(element);
  }
  // Nothing is moving: let the loop die rather than tick forever. The `play` listener
  // starts it again.
  if (playing) scheduleVideoPass();
}

/** Re-scores a video that has already been cleared. Only a hit changes anything. */
async function resample(element) {
  const record = records.get(element);
  if (!state.active || !state.settings.analyzeVideos) return;
  if (record?.status !== "safe" || !liveVideos.has(element)) return;
  if (element.readyState < HAVE_CURRENT_DATA) return;
  if (Date.now() - record.sampledAt < MIN_SAMPLE_GAP_MS) return;

  const src = record.src;
  const value = await sampleVideo(element);

  // It may have been revealed, swapped or torn down while the model was running.
  const current = records.get(element);
  if (!state.active || current?.status !== "safe" || current.src !== src) return;
  if (value >= state.settings.threshold) block(element);
  else countMiss(element, value);
}

/* ------------------------------------------------------------ CSS background pass */

function scanBackgrounds() {
  if (!state.active || !state.settings.scanBackgrounds || !state.keywordPattern) return;
  for (const element of document.querySelectorAll("*")) {
    if (element.hasAttribute(BG_ATTR)) continue;
    const image = getComputedStyle(element).backgroundImage;
    if (!image || image === "none" || !image.includes("url(")) continue;
    element.setAttribute(BG_ATTR, "safe");
    if (renderedSize(element) < state.settings.minImageSize) continue;
    if (state.keywordPattern.test(normalizeText(image))) {
      element.setAttribute(BG_ATTR, "blocked");
      state.blocked += 1;
      scheduleReport();
    }
  }
}

function scheduleBackgroundScan() {
  if (!state.settings?.scanBackgrounds) return;
  // This walks every element and forces a style resolve, so it waits for the DOM to
  // settle and then for the browser to be idle.
  clearTimeout(backgroundScanTimer);
  backgroundScanTimer = setTimeout(() => {
    window.requestIdleCallback(scanBackgrounds, { timeout: 1000 });
  }, 400);
}

/* ----------------------------------------------------------------------- scanning */

function scan(root) {
  if (isMedia(root)) evaluate(root);
  if (root.querySelectorAll) {
    for (const element of root.querySelectorAll("img, video")) evaluate(element);
  }
  scheduleBackgroundScan();
}

function scheduleReport() {
  clearTimeout(reportTimer);
  reportTimer = setTimeout(() => {
    chrome.runtime.sendMessage({ type: MSG.REPORT, count: state.blocked }).catch(() => {});
  }, 250);
}

/* ------------------------------------------------------------------- interactions */

function onClickCapture(event) {
  if (!state.active || !state.settings.clickToReveal) return;
  const element = event.target;
  if (!isMedia(element) || element.getAttribute(ATTR) !== "blocked") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  unblock(element, "revealed");
}

function revealAll() {
  for (const element of document.querySelectorAll(`[${ATTR}="blocked"]`)) {
    unblock(element, "revealed");
  }
  for (const element of document.querySelectorAll(`[${BG_ATTR}="blocked"]`)) {
    element.setAttribute(BG_ATTR, "revealed");
    state.blocked = Math.max(0, state.blocked - 1);
  }
  scheduleReport();
}

/* ------------------------------------------------------------------- entry points */

function stopVideoSampling() {
  clearTimeout(videoTimer);
  videoTimer = null;
  liveVideos.clear();
}

function teardown() {
  document.documentElement?.setAttribute(OFF_ATTR, "true");
  for (const element of document.querySelectorAll(`[${ATTR}]`)) reset(element);
  for (const element of document.querySelectorAll(`[${BG_ATTR}]`)) element.removeAttribute(BG_ATTR);
  stopVideoSampling();
  state.blocked = 0;
  scheduleReport();
}

function applySettings(settings) {
  const wasActive = state.active;
  state.settings = settings;
  state.keywordPattern = compileKeywords(settings.keywords);
  state.active = settings.enabled && !isAllowlisted(settings.allowlist, location.hostname);

  if (!state.active) {
    teardown();
    return;
  }

  document.documentElement?.removeAttribute(OFF_ATTR);
  // A settings change invalidates every earlier verdict, so start from a clean slate.
  if (wasActive) {
    for (const element of document.querySelectorAll(`[${ATTR}]`)) reset(element);
    for (const element of document.querySelectorAll(`[${BG_ATTR}]`)) element.removeAttribute(BG_ATTR);
    stopVideoSampling();
    state.blocked = 0;
  }
  scan(document);
}

function start() {
  viewportObserver = new IntersectionObserver(onVisible, { rootMargin: VIEWPORT_MARGIN });

  domObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes") {
        evaluate(mutation.target);
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) scan(node);
      }
    }
  });
  // At document_start the document element usually exists, but not on every document type.
  domObserver.observe(document.documentElement ?? document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "srcset", "poster", "alt", "title"]
  });

  document.addEventListener("click", onClickCapture, { capture: true });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === MSG.REVEAL_ALL) revealAll();
  });

  onSettingsChanged(applySettings);
  readSettings().then(applySettings);
}

start();
