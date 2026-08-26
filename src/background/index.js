import {
  readSettings,
  onSettingsChanged,
  toMatchPattern,
  riskScore,
  STATS
} from "../shared/settings.js";
import { MSG, UNKNOWN_SCORE, isFromExtensionPage } from "../shared/messages.js";
import { isFetchableUrl } from "../shared/urls.js";

const OFFSCREEN_URL = "src/offscreen/offscreen.html";
const PREBLUR_SCRIPT_ID = "imgfilter-preblur";
const MAX_CONCURRENT = 3;
const CACHE_LIMIT = 3000;
const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;
const IDLE_ALARM = "imgfilter-idle";

/**
 * url -> class-probability vector (or null when the URL could not be fetched).
 * Caching the raw vector rather than a verdict means changing the threshold or the
 * "suggestive" toggle re-uses every result instead of re-running the model.
 */
const classCache = new Map();
/** tabId -> Map<frameId, count> */
const tabCounts = new Map();

let running = 0;
const queue = [];
let offscreenReady = null;
let lastActivity = 0;
let settingsCache = null;

function getSettings() {
  settingsCache ||= readSettings();
  return settingsCache;
}

/* ----------------------------------------------------------------- score cache */

function cacheGet(url) {
  if (!classCache.has(url)) return undefined;
  const classes = classCache.get(url);
  classCache.delete(url); // re-insert to keep the map in least-recently-used order
  classCache.set(url, classes);
  return classes;
}

function cacheSet(url, classes) {
  classCache.set(url, classes);
  while (classCache.size > CACHE_LIMIT) {
    classCache.delete(classCache.keys().next().value);
  }
}

/* ------------------------------------------------------------ offscreen document */

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  offscreenReady ||= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification: "Decode and classify image data locally with the bundled NSFW model."
    })
    .catch((error) => {
      // A concurrent caller may have created it first; anything else is a real failure.
      if (!String(error).includes("Only a single offscreen")) throw error;
    })
    .finally(() => {
      offscreenReady = null;
    });
  await offscreenReady;
}

async function closeOffscreenIfIdle() {
  if (running > 0 || queue.length > 0) return;
  if (Date.now() - lastActivity < IDLE_SHUTDOWN_MS) return;
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
}

/* ------------------------------------------------------------------ score queue */

function enqueue(job) {
  return new Promise((resolve) => {
    queue.push({ job, resolve });
    pump();
  });
}

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const { job, resolve } = queue.shift();
    running += 1;
    job()
      .catch(() => null)
      .then((result) => {
        running -= 1;
        lastActivity = Date.now();
        resolve(result);
        pump();
      });
  }
}

/** Resolves to the offscreen document's `{ classes, error }` reply. */
async function runModel(url, dataUrl, attempt = 0) {
  await ensureOffscreen();
  try {
    const response = await chrome.runtime.sendMessage({
      type: MSG.SCORE_OFFSCREEN,
      target: "offscreen",
      url,
      dataUrl
    });
    return response ?? { classes: null, error: "מסמך הניתוח לא ענה" };
  } catch (error) {
    // The document can be torn down between ensureOffscreen() and the send.
    if (attempt === 0) return runModel(url, dataUrl, 1);
    throw error;
  }
}

/**
 * `cache: false` is what a video frame asks for: the picture behind that URL changes from
 * one sample to the next, so caching it by URL would answer the next question with the
 * previous frame's verdict.
 *
 * `pixelsOnly: true` says the caller knows this URL is unfetchable from here — a `blob:`
 * URL that only resolves inside its own page. It still gets a cache lookup, which is the
 * point: without one, every `blob:` image would re-run the model after any settings change.
 */
async function scoreImage({ url, dataUrl, cache = true, pixelsOnly = false }) {
  const settings = await getSettings();

  if (!dataUrl && cache) {
    const cached = cacheGet(url);
    if (cached !== undefined) {
      return cached
        ? { score: riskScore(cached, settings) }
        : { score: UNKNOWN_SCORE, needsPixels: true };
    }
  }

  // Nothing cached and no pixels attached, so this would become a fetch. Only URLs we are
  // willing to request on the page's behalf get that far; the rest are sent back for
  // pixels, which reaches the same picture without the extension touching the network.
  if (!dataUrl && (pixelsOnly || !isFetchableUrl(url))) {
    return { score: UNKNOWN_SCORE, needsPixels: true };
  }

  const classes = (await enqueue(() => runModel(url, dataUrl)))?.classes ?? null;

  if (!classes) {
    if (dataUrl) return { score: UNKNOWN_SCORE };
    // Remember the miss so the next sighting skips straight to the pixel path, and ask
    // the frame for pixels: it can read same-origin, CORS-clean and blob: images that
    // the extension origin cannot fetch on its own.
    if (cache) cacheSet(url, null);
    return { score: UNKNOWN_SCORE, needsPixels: true };
  }

  if (cache) cacheSet(url, classes);
  const score = riskScore(classes, settings);
  recordStats(score, settings);
  return { score };
}

/**
 * Counters are batched: an image-heavy page scores hundreds of images, and one storage
 * round-trip each would be pure overhead — and would wake every settings listener.
 * Serialised so concurrent flushes cannot lose an increment to a read-modify-write race.
 */
const pending = { analyzedTotal: 0, blockedTotal: 0 };
const STATS_FLUSH_MS = 5000;
/** Cap on how many increments a worker suspend can swallow before they are written. */
const STATS_FLUSH_AFTER = 50;
let statsChain = Promise.resolve();
let statsTimer;

function recordStats(score, settings) {
  pending.analyzedTotal += 1;
  if (score >= settings.threshold) pending.blockedTotal += 1;
  // Flush on volume as well as on time: during a burst the timer keeps being pushed out,
  // which is exactly when a suspend would cost the most.
  if (pending.analyzedTotal >= STATS_FLUSH_AFTER) {
    flushStats();
    return;
  }
  clearTimeout(statsTimer);
  statsTimer = setTimeout(flushStats, STATS_FLUSH_MS);
}

function flushStats() {
  clearTimeout(statsTimer);
  const delta = { ...pending };
  if (!delta.analyzedTotal) return;
  pending.analyzedTotal = 0;
  pending.blockedTotal = 0;
  statsChain = statsChain
    .then(async () => {
      const stats = await chrome.storage.local.get(STATS);
      await chrome.storage.local.set({
        analyzedTotal: stats.analyzedTotal + delta.analyzedTotal,
        blockedTotal: stats.blockedTotal + delta.blockedTotal
      });
    })
    .catch(() => {});
}

/* ----------------------------------------------------------------- badge counter */

function tabTotal(tabId) {
  return [...(tabCounts.get(tabId)?.values() ?? [])].reduce((sum, n) => sum + n, 0);
}

function updateBadge(tabId) {
  const total = tabTotal(tabId);
  chrome.action
    .setBadgeText({ tabId, text: total > 0 ? String(Math.min(total, 999)) : "" })
    .catch(() => {});
}

function recordCount(tabId, frameId, count) {
  if (tabId === undefined) return;
  const frames = tabCounts.get(tabId) ?? new Map();
  frames.set(frameId ?? 0, count);
  tabCounts.set(tabId, frames);
  updateBadge(tabId);
}

/* ---------------------------------------------------------------------- self-test */

/**
 * A 16×16 solid-colour PNG, inline. A `data:` URL carries its own bytes, so this walks
 * the real analysis chain — worker, offscreen document, model, scoring — without a
 * network request, a page, or anything a site could interfere with. If it fails, the
 * extension is broken everywhere; if it passes, a site that hides nothing is a scoring
 * or a pixel-access question rather than a broken install.
 */
const TEST_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mOo" +
  "aKolCTGMahjVMHw1AABXsncQ/UM6vAAAAABJRU5ErkJggg==";

async function selfTest() {
  const steps = [];
  const record = (name, ok, detail) => {
    steps.push({ name, ok, detail });
    return ok;
  };
  const reason = (error) => String(error?.message ?? error);

  let settings;
  try {
    settings = await getSettings();
    record("קריאת ההגדרות", true, `סף חסימה ${settings.threshold}`);
  } catch (error) {
    record("קריאת ההגדרות", false, reason(error));
    return { steps };
  }

  // The two switches that turn the analysis chain into a no-op are checked before the
  // chain itself. Without them the test happily reports a healthy pipeline for an
  // extension that is switched off — which is the single most likely reason a user is
  // running it in the first place, and the one answer it must never rule out.
  if (!record("«המסנן פעיל» מופעל", settings.enabled, settings.enabled
    ? undefined
    : "המסנן כבוי גלובלית. כל פריים מפרק את עצמו ושום דבר לא מסונן, גם אם כל שאר השרשרת תקינה")) {
    return { steps };
  }

  if (!record("«ניתוח תוכן התמונה» מופעל", settings.analyzeContent, settings.analyzeContent
    ? undefined
    : "כל עוד ההגדרה הזו כבויה, המודל לעולם לא ירוץ ותמונות ייחסמו רק לפי מילות חסימה")) {
    return { steps };
  }

  if (settings.allowlist.length) {
    // Not a failure: it is per-site and deliberate. But "nothing is hidden on X" has an
    // obvious answer if X is on this list, and the test is the place to surface it.
    record("אתרים ללא סינון", true, `${settings.allowlist.length} ברשימה: ${settings.allowlist.join(", ")}`);
  }

  try {
    await ensureOffscreen();
    const exists = await chrome.offscreen.hasDocument();
    if (!record("יצירת מסמך הניתוח", exists, exists ? undefined : "המסמך לא קיים גם אחרי היצירה")) {
      return { steps };
    }
  } catch (error) {
    record("יצירת מסמך הניתוח", false, reason(error));
    return { steps };
  }

  // Deliberately not through `enqueue`: the queue swallows the reason, and the reason is
  // the entire point of this function.
  let response;
  try {
    response = await runModel(TEST_IMAGE, undefined);
  } catch (error) {
    record("הרצת המודל", false, reason(error));
    return { steps };
  }

  const classes = response?.classes;
  if (!record("הרצת המודל", Boolean(classes), classes
    ? Object.entries(classes).map(([name, p]) => `${name} ${p.toFixed(2)}`).join(" · ")
    : response?.error ?? "המודל החזיר תשובה ריקה")) {
    return { steps };
  }

  const score = riskScore(classes, settings);
  record("חישוב הציון", true, `${score.toFixed(3)} — ${score >= settings.threshold ? "מעל" : "מתחת ל"}סף`);

  // Writing the counter is part of the chain: it is what the statistics line reports, so
  // a self-test that passed while the counter stayed at zero would still be a mystery.
  const before = (await chrome.storage.local.get(STATS)).analyzedTotal;
  recordStats(score, settings);
  flushStats();
  await statsChain;
  const after = (await chrome.storage.local.get(STATS)).analyzedTotal;
  record("עדכון מונה ההרצות", after > before, `${before} ← ${after}`);

  return { steps };
}

/* ------------------------------------------------- dynamic pre-blur registration */

async function syncPreblur(settings) {
  const shouldRegister = settings.enabled && settings.hideUntilChecked;
  const registered = await chrome.scripting
    .getRegisteredContentScripts({ ids: [PREBLUR_SCRIPT_ID] })
    .catch(() => []);

  if (!shouldRegister) {
    if (registered.length) {
      await chrome.scripting.unregisterContentScripts({ ids: [PREBLUR_SCRIPT_ID] }).catch(() => {});
    }
    return;
  }

  const definition = {
    id: PREBLUR_SCRIPT_ID,
    matches: ["<all_urls>"],
    excludeMatches: settings.allowlist.flatMap(toMatchPattern),
    css: ["src/content/preblur.css"],
    runAt: "document_start",
    allFrames: true,
    persistAcrossSessions: true
  };

  const action = registered.length
    ? chrome.scripting.updateContentScripts([definition])
    : chrome.scripting.registerContentScripts([definition]);
  // Chrome rejects the whole call over one malformed exclude pattern, and the symptom is
  // "hide until checked" quietly doing nothing. Swallowing that silently hides the cause.
  await action.catch((error) => console.warn("[imgfilter] pre-blur registration failed:", error));
}

/* ------------------------------------------------------------------- wiring it up */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "offscreen") return false; // meant for the offscreen document

  if (message?.type === MSG.SCORE) {
    scoreImage(message).then(sendResponse, () => sendResponse({ score: UNKNOWN_SCORE }));
    return true;
  }

  if (message?.type === MSG.REPORT) {
    recordCount(sender.tab?.id, sender.frameId, message.count);
    return false;
  }

  if (message?.type === MSG.SELFTEST) {
    // Extension pages only: a content script — which is to say any page on the web — must
    // not be able to make the worker spin up the model on demand. `sender.tab` is the
    // wrong test here even though TAB_STATE above can use it; see `isFromExtensionPage`.
    if (!isFromExtensionPage(sender, chrome.runtime.getURL(""))) return false;
    selfTest().then(sendResponse, (error) =>
      sendResponse({ steps: [{ name: "הבדיקה קרסה", ok: false, detail: String(error?.message ?? error) }] })
    );
    return true;
  }

  if (message?.type === MSG.TAB_STATE) {
    // Only the popup may ask about a tab it names. A content script — which is to say any
    // page on the web — has `sender.tab`, and has no business reading another tab's count.
    if (sender.tab) return false;
    sendResponse({ blocked: tabTotal(message.tabId) });
    return false;
  }

  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  tabCounts.delete(tabId);
  updateBadge(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => tabCounts.delete(tabId));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== IDLE_ALARM) return;
  // The alarm is the durable timer: a worker suspend can eat the setTimeout above, so the
  // minute tick bounds how long a buffered counter can sit unwritten while the worker lives.
  flushStats();
  closeOffscreenIfIdle();
});

async function boot() {
  chrome.action.setBadgeBackgroundColor({ color: "#315d4b" }).catch(() => {});
  chrome.alarms.create(IDLE_ALARM, { periodInMinutes: 1 });
  await syncPreblur(await getSettings());
}

chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);
// Also on every worker wake-up: registration is idempotent, and this self-heals if a
// previous session left the pre-blur script out of sync with the settings.
boot();

onSettingsChanged((settings) => {
  settingsCache = Promise.resolve(settings);
  syncPreblur(settings);
});
