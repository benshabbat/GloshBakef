import * as nsfwjs from "nsfwjs";

const DEFAULTS = {
  enabled: true,
  sensitivity: "balanced",
  keywords: [
    "nsfw", "nude", "nudity", "lingerie", "bikini", "swimwear",
    "explicit", "adult", "sexy", "porn", "erotic", "onlyfans"
  ]
};

const state = { ...DEFAULTS };
const blocked = new WeakSet();
const analyzed = new WeakSet();
const pending = new Set();
let observer;
let modelPromise;

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[._/?=&-]+/g, " ");
}

function imageText(image) {
  return normalize([
    image.alt,
    image.title,
    image.currentSrc,
    image.src,
    image.closest("a")?.href
  ].join(" "));
}

function hasBlockedText(image) {
  const text = imageText(image);
  return state.keywords.some((keyword) => text.includes(normalize(keyword)));
}

function hideImage(image) {
  blocked.add(image);
  image.dataset.imageFilterBlocked = "true";
  image.setAttribute("aria-label", "תמונה הוסתרה על ידי מסנן התמונות");
  image.style.setProperty("filter", "blur(24px) grayscale(1)", "important");
  image.style.setProperty("background", "#e7e2d8", "important");
  image.style.setProperty("opacity", "0.18", "important");
  image.style.setProperty("transition", "filter 160ms ease, opacity 160ms ease", "important");
}

function getModel() {
  modelPromise ||= nsfwjs.load("MobileNetV2");
  return modelPromise;
}

function probability(predictions, label) {
  return predictions.find((prediction) => prediction.className === label)?.probability || 0;
}

async function analyzeImage(image) {
  if (!state.enabled || analyzed.has(image) || pending.has(image)) return;
  if (hasBlockedText(image)) {
    hideImage(image);
    analyzed.add(image);
    return;
  }
  if (!image.complete || !image.naturalWidth) return;

  pending.add(image);
  try {
    const predictions = await (await getModel()).classify(image);
    const risk = Math.max(
      probability(predictions, "Porn"),
      probability(predictions, "Sexy"),
      probability(predictions, "Hentai")
    );
    const threshold = state.sensitivity === "strict" ? 0.45 : 0.7;
    if (risk >= threshold) hideImage(image);
    analyzed.add(image);
  } catch {
    // Some cross-origin images cannot be read by the browser canvas.
  } finally {
    pending.delete(image);
  }
}

function scan(root = document) {
  if (root instanceof HTMLImageElement) analyzeImage(root);
  root.querySelectorAll?.("img").forEach(analyzeImage);
}

function start() {
  scan();
  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) scan(node);
      });
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

chrome.storage.sync.get(DEFAULTS, (saved) => {
  Object.assign(state, saved);
  start();
});

chrome.storage.onChanged.addListener((changes) => {
  for (const [key, change] of Object.entries(changes)) state[key] = change.newValue;
  document.querySelectorAll("img[data-image-filter-blocked]").forEach((image) => {
    if (!state.enabled) {
      image.style.removeProperty("filter");
      image.style.removeProperty("opacity");
      image.style.removeProperty("background");
      blocked.delete(image);
    } else {
      analyzeImage(image);
    }
  });
});
