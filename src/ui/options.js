import {
  SETTINGS,
  STATS,
  BOUNDS,
  DEFAULT_KEYWORDS,
  readSettings,
  readStats,
  writeSettings,
  parseKeywords,
  parseHostnames
} from "../shared/settings.js";
import { MSG } from "../shared/messages.js";

const TOGGLES = [
  "enabled",
  "hideUntilChecked",
  "clickToReveal",
  "analyzeContent",
  "includeSuggestive",
  "scanBackgrounds",
  "analyzeVideos",
  "pauseBlockedVideos"
];

/** The plain integer inputs. Their ranges come from BOUNDS, the same ones `migrate` clamps to. */
const NUMBERS = ["minImageSize", "videoSampleSeconds"];

const el = (id) => document.querySelector(`#${id}`);
const status = el("status");
let statusTimer;

function announce(text) {
  status.textContent = text;
  status.dataset.visible = "true";
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    status.dataset.visible = "false";
  }, 1600);
}

async function save(patch) {
  await writeSettings(patch);
  announce("נשמר");
}

function fill(settings) {
  for (const id of TOGGLES) el(id).checked = Boolean(settings[id]);
  el("threshold").value = settings.threshold;
  el("threshold-value").textContent = settings.threshold.toFixed(2);
  for (const id of NUMBERS) el(id).value = settings[id];
  el("keywords").value = settings.keywords.join(", ");
  el("allowlist").value = settings.allowlist.join("\n");
}

const number = (value) => value.toLocaleString("he-IL");

async function refreshStats() {
  const stats = await readStats();
  // Counts model runs, not elements and not decisions: a repeat sighting of the same
  // image is answered from the cache and never reaches the model, while a playing video
  // is sampled afresh every few seconds.
  el("stats").textContent = stats.analyzedTotal
    ? `המודל הורץ ${number(stats.analyzedTotal)} פעמים, ו־${number(stats.blockedTotal)} מההרצות הובילו להסתרה. תמונה שכבר נבדקה נענית מהזיכרון ואינה נספרת שוב.`
    : "המודל עוד לא הורץ.";
}

/** Textareas save while typing, but only once the user pauses. */
function debounce(fn, delay = 500) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

for (const id of TOGGLES) {
  el(id).addEventListener("change", () => save({ [id]: el(id).checked }));
}

/** Drives the input's own range from BOUNDS, so the two can never drift apart. */
function bind(id) {
  const [min, max] = BOUNDS[id];
  el(id).min = min;
  el(id).max = max;
  return [min, max];
}

bind("threshold");
el("threshold").addEventListener("input", () => {
  el("threshold-value").textContent = Number(el("threshold").value).toFixed(2);
});
el("threshold").addEventListener("change", () => save({ threshold: Number(el("threshold").value) }));

for (const id of NUMBERS) {
  const [min, max] = bind(id);
  el(id).addEventListener("change", () => {
    // Snap the box back to what was actually stored, so it never shows a rejected value.
    const value = Math.max(min, Math.min(max, Math.round(Number(el(id).value) || min)));
    el(id).value = value;
    save({ [id]: value });
  });
}

el("keywords").addEventListener(
  "input",
  debounce(() => save({ keywords: parseKeywords(el("keywords").value) }))
);

el("allowlist").addEventListener(
  "input",
  debounce(() => save({ allowlist: parseHostnames(el("allowlist").value) }))
);

// Drop anything that did not parse as a hostname, so the box always shows what is stored.
el("allowlist").addEventListener("blur", async () => {
  const settings = await readSettings();
  el("allowlist").value = settings.allowlist.join("\n");
});

el("reset-keywords").addEventListener("click", () => {
  el("keywords").value = DEFAULT_KEYWORDS.join(", ");
  save({ keywords: DEFAULT_KEYWORDS });
});

/**
 * Every failure in the analysis chain fails open, so a broken pipeline looks exactly like
 * a page with nothing to hide. This is the one place that tells them apart.
 */
el("selftest").addEventListener("click", async () => {
  const button = el("selftest");
  const out = el("selftest-out");
  button.disabled = true;
  button.textContent = "בודק…";
  out.replaceChildren();

  let steps;
  try {
    steps = (await chrome.runtime.sendMessage({ type: MSG.SELFTEST }))?.steps;
    // Resolving with nothing is different from failing to reach anyone: a listener did
    // answer, it just did not recognise this message. That is a worker still running an
    // older build — the pages are re-read from disk on every open, the worker is not.
    if (!steps?.length) {
      steps = [{
        name: "שירות הרקע רץ מגרסה ישנה",
        ok: false,
        detail: "הוא ענה אך אינו מכיר את הבדיקה. רענן את התוסף ב־chrome://extensions (האייקון המעגלי) והרץ שוב."
      }];
    }
  } catch (error) {
    steps = [{
      name: "אין קשר לשירות הרקע",
      ok: false,
      detail: `${error?.message ?? error} — שירות הרקע אינו רץ כלל. בדוק אם יש כפתור «שגיאות» בכרטיס התוסף ב־chrome://extensions.`
    }];
  }

  for (const step of steps) {
    const item = document.createElement("li");
    item.dataset.ok = String(step.ok);
    item.append(
      Object.assign(document.createElement("span"), { className: "mark", textContent: step.ok ? "✓" : "✕" }),
      Object.assign(document.createElement("span"), { textContent: step.name })
    );
    if (step.detail) {
      item.append(Object.assign(document.createElement("span"), { className: "detail", textContent: step.detail }));
    }
    out.append(item);
  }

  const failed = steps.find((step) => !step.ok);
  const summary = document.createElement("li");
  summary.dataset.ok = String(!failed);
  summary.append(
    Object.assign(document.createElement("span"), { className: "mark", textContent: failed ? "✕" : "✓" }),
    Object.assign(document.createElement("span"), {
      textContent: failed ? `הצינור נעצר ב: ${failed.name}` : "הצינור שלם — הניתוח עובד"
    })
  );
  if (!failed) {
    summary.append(Object.assign(document.createElement("span"), {
      className: "detail",
      textContent: "אתר שבו שום דבר לא מוסתר הוא שאלה של סף או של גישה לפיקסלים, לא של התקנה שבורה."
    }));
  }
  out.append(summary);

  button.disabled = false;
  button.textContent = "הרץ בדיקה שוב";
  await refreshStats();
});

el("reset-stats").addEventListener("click", async () => {
  await chrome.storage.local.set(STATS);
  await refreshStats();
  announce("המונים אופסו");
});

el("reset-all").addEventListener("click", async () => {
  await chrome.storage.sync.clear();
  await chrome.storage.sync.set(SETTINGS);
  fill(await readSettings());
  announce("ההגדרות אופסו");
});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") refreshStats();
});

readSettings().then(fill);
refreshStats();
