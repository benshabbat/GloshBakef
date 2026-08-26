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
