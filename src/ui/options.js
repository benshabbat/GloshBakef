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
  "scanBackgrounds"
];

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
  el("minImageSize").value = settings.minImageSize;
  el("keywords").value = settings.keywords.join(", ");
  el("allowlist").value = settings.allowlist.join("\n");
}

async function refreshStats() {
  const stats = await readStats();
  el("stats").textContent = stats.analyzedTotal
    ? `נבדקו ${stats.analyzedTotal.toLocaleString("he-IL")} תמונות, מתוכן ${stats.blockedTotal.toLocaleString("he-IL")} הוסתרו.`
    : "עדיין לא נבדקו תמונות.";
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

el("minImageSize").addEventListener("change", () => {
  const value = Math.max(0, Math.min(1000, Math.round(Number(el("minImageSize").value) || 0)));
  el("minImageSize").value = value;
  save({ minImageSize: value });
});

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
