import {
  SETTINGS,
  STATS,
  DEFAULT_KEYWORDS,
  readSettings,
  readStats,
  writeSettings,
  parseKeywords,
  parseHostname
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

/** id -> [min, max], for the plain integer inputs. */
const NUMBERS = {
  minImageSize: [0, 1000],
  videoSampleSeconds: [1, 60]
};

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
  for (const id of Object.keys(NUMBERS)) el(id).value = settings[id];
  el("keywords").value = settings.keywords.join(", ");
  el("allowlist").value = settings.allowlist.join("\n");
}

async function refreshStats() {
  const stats = await readStats();
  // Counts checks, not elements: a playing video is checked again every few seconds.
  el("stats").textContent = stats.analyzedTotal
    ? `בוצעו ${stats.analyzedTotal.toLocaleString("he-IL")} בדיקות תוכן, ומתוכן ${stats.blockedTotal.toLocaleString("he-IL")} הובילו להסתרה.`
    : "עדיין לא בוצעו בדיקות תוכן.";
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

el("threshold").addEventListener("input", () => {
  el("threshold-value").textContent = Number(el("threshold").value).toFixed(2);
});
el("threshold").addEventListener("change", () => save({ threshold: Number(el("threshold").value) }));

for (const [id, [min, max]] of Object.entries(NUMBERS)) {
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
  debounce(() => {
    const hosts = el("allowlist")
      .value.split(/[\n,]/)
      .map(parseHostname)
      .filter(Boolean);
    save({ allowlist: [...new Set(hosts)] });
  })
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
