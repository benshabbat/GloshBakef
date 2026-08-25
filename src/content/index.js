import { readSettings, onSettingsChanged, isAllowlisted } from "../shared/settings.js";
import { compileKeywords, normalizeText, matchesKeyword } from "../shared/keywords.js";
import { MSG, UNKNOWN_SCORE } from "../shared/messages.js";

const ATTR = "data-imgfilter";
const BG_ATTR = "data-imgfilter-bg";
const OFF_ATTR = "data-imgfilter-off";
const SNAPSHOT_SIZE = 224; // matches the model input, so the worker never resizes twice.
const VIEWPORT_MARGIN = "400px";

const LABEL = "תמונה הוסתרה על ידי מסנן התמונות";
const TITLE_REVEALABLE = `${LABEL}. לחיצה תחשוף אותה.`;

const state = {
  settings: null,
  keywordPattern: null,
  active: false,
  blocked: 0
};

/** element -> { src, status } for every element we have looked at. */
const records = new WeakMap();
const pendingLoad = new WeakSet();
/** element -> the page's own title/aria-label, so hiding an image never destroys them. */
const originalLabels = new WeakMap();

let viewportObserver;
let domObserver;
let reportTimer;
let backgroundScanTimer;

/* ------------------------------------------------------------------ helpers */

function isImage(node) {
  return node instanceof HTMLImageElement || node instanceof HTMLVideoElement;
}

function sourceOf(element) {
  if (element instanceof HTMLVideoElement) return element.poster || "";
  return element.currentSrc || element.getAttribute("src") || "";
}

function textAround(element) {
  return [
    element.alt,
    element.title,
    element.getAttribute("aria-label"),
    sourceOf(element),
    element.closest("a")?.href
  ].join(" ");
}

function hasBlockedKeyword(element) {
  return matchesKeyword(state.keywordPattern, textAround(element));
}

/** Intrinsic size, when the browser already knows it. */
function intrinsicSize(element) {
  if (element instanceof HTMLVideoElement) return 0;
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
  element.setAttribute("aria-label", LABEL);
  element.setAttribute("title", state.settings.clickToReveal ? TITLE_REVEALABLE : `${LABEL}.`);
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

function unblock(element, status) {
  if (records.get(element)?.status === "blocked") {
    state.blocked = Math.max(0, state.blocked - 1);
    scheduleReport();
  }
  restoreLabels(element);
  mark(element, status);
}

function allow(element) {
  unblock(element, "safe");
}

function reset(element) {
  if (records.get(element)?.status === "blocked") state.blocked = Math.max(0, state.blocked - 1);
  restoreLabels(element);
  records.delete(element);
  element.removeAttribute(ATTR);
  viewportObserver?.unobserve(element);
}

/* ------------------------------------------------------------- the state machine */

function evaluate(element) {
  if (!state.active || !isImage(element)) return;

  const src = sourceOf(element);
  const record = records.get(element);

  // Re-run only when the effective source actually changed (SPAs swap src constantly).
  if (record && record.src === src && record.status !== "pending") return;
  if (!record || record.src !== src) records.set(element, { src, status: "pending" });

  if (hasBlockedKeyword(element)) {
    block(element);
    return;
  }

  if (!src) {
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

  // Not decoded yet: the browser does not know the size and the bytes may not be cached.
  if (element instanceof HTMLImageElement && !element.complete) {
    mark(element, "pending");
    waitForLoad(element);
    return;
  }

  mark(element, "pending");
  viewportObserver.observe(element);
}

function waitForLoad(element) {
  if (pendingLoad.has(element)) return;
  pendingLoad.add(element);
  const done = () => {
    pendingLoad.delete(element);
    element.removeEventListener("load", done);
    element.removeEventListener("loadedmetadata", done);
    element.removeEventListener("error", failed);
    const record = records.get(element);
    if (record) record.src = null; // force a fresh evaluation
    evaluate(element);
  };
  const failed = () => {
    pendingLoad.delete(element);
    element.removeEventListener("load", done);
    element.removeEventListener("loadedmetadata", done);
    element.removeEventListener("error", failed);
    allow(element); // a broken image cannot show anything
  };
  element.addEventListener("load", done, { once: true });
  element.addEventListener("loadedmetadata", done, { once: true });
  element.addEventListener("error", failed, { once: true });
}

function onVisible(entries) {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const element = entry.target;
    viewportObserver.unobserve(element);
    if (records.get(element)?.status !== "pending") continue;

    const rendered = renderedSize(element);
    if (rendered > 0 && rendered < state.settings.minImageSize) {
      allow(element);
      continue;
    }
    score(element);
  }
}

/* ---------------------------------------------------------------- classification */

async function score(element) {
  const src = sourceOf(element);
  if (!src) {
    allow(element);
    return;
  }

  try {
    // blob: URLs only resolve inside this page, so go straight to the pixel path.
    const viaUrl = src.startsWith("blob:")
      ? { score: UNKNOWN_SCORE, needsPixels: true }
      : await chrome.runtime.sendMessage({ type: MSG.SCORE, url: src });

    let result = viaUrl;
    if (result?.needsPixels) {
      const dataUrl = snapshot(element);
      result = dataUrl
        ? await chrome.runtime.sendMessage({ type: MSG.SCORE, url: src, dataUrl })
        : { score: UNKNOWN_SCORE };
    }

    if (!state.active || records.get(element)?.src !== src) return;

    const value = result?.score ?? UNKNOWN_SCORE;
    if (value >= state.settings.threshold) block(element);
    else allow(element);
  } catch {
    // The worker can be torn down mid-flight; failing open beats blurring the page forever.
    allow(element);
  }
}

/**
 * Draws the already-decoded element into a small canvas. Works for same-origin,
 * CORS-clean, `blob:` and `data:` images; throws for tainted ones, which we treat
 * as "cannot inspect".
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
  if (isImage(root)) evaluate(root);
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
  if (!isImage(element) || element.getAttribute(ATTR) !== "blocked") return;
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

function teardown() {
  document.documentElement?.setAttribute(OFF_ATTR, "true");
  for (const element of document.querySelectorAll(`[${ATTR}]`)) reset(element);
  for (const element of document.querySelectorAll(`[${BG_ATTR}]`)) element.removeAttribute(BG_ATTR);
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
