import {
  readSettings,
  writeSettings,
  isAllowlisted,
  parseHostname,
  SENSITIVITY_PRESETS
} from "../shared/settings.js";
import { MSG } from "../shared/messages.js";

const els = {
  main: document.querySelector("main"),
  summary: document.querySelector("#tab-summary"),
  enabled: document.querySelector("#enabled"),
  siteEnabled: document.querySelector("#site-enabled"),
  hostname: document.querySelector("#hostname"),
  sensitivity: document.querySelector("#sensitivity"),
  reveal: document.querySelector("#reveal"),
  settings: document.querySelector("#settings")
};

let settings;
let tab;
let hostname = "";

function closestPreset(threshold) {
  return Object.entries(SENSITIVITY_PRESETS).reduce((best, entry) =>
    Math.abs(entry[1] - threshold) < Math.abs(best[1] - threshold) ? entry : best
  )[0];
}

function render(blocked) {
  const active = settings.enabled && hostname && !isAllowlisted(settings.allowlist, hostname);

  els.main.dataset.disabled = String(!settings.enabled);
  els.enabled.checked = settings.enabled;
  els.siteEnabled.checked = active;
  els.siteEnabled.disabled = !settings.enabled || !hostname;
  els.hostname.textContent = hostname || "לא ניתן לסנן את הדף הזה";

  const preset = closestPreset(settings.threshold);
  for (const button of els.sensitivity.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.preset === preset));
  }

  if (!settings.enabled) els.summary.textContent = "המסנן מושהה.";
  else if (!hostname) els.summary.textContent = "אין דף פעיל לסינון.";
  else if (!active) els.summary.textContent = "האתר הזה ברשימת ההיתר.";
  else if (blocked > 0) els.summary.textContent = `${blocked} תמונות וסרטונים מוסתרים בלשונית הזו.`;
  else els.summary.textContent = "לא הוסתר דבר בלשונית הזו.";
}

async function refresh() {
  settings = await readSettings();
  const { blocked = 0 } = tab?.id
    ? await chrome.runtime.sendMessage({ type: MSG.TAB_STATE, tabId: tab.id }).catch(() => ({}))
    : {};
  render(blocked);
}

async function update(patch) {
  settings = { ...settings, ...patch };
  render(0);
  await writeSettings(patch);
  refresh();
}

els.enabled.addEventListener("change", () => update({ enabled: els.enabled.checked }));

els.siteEnabled.addEventListener("change", () => {
  if (!hostname) return;
  const allowlist = els.siteEnabled.checked
    ? settings.allowlist.filter((entry) => entry !== hostname)
    : [...new Set([...settings.allowlist, hostname])];
  update({ allowlist });
});

els.sensitivity.addEventListener("click", (event) => {
  const preset = event.target.closest("button")?.dataset.preset;
  if (preset) update({ threshold: SENSITIVITY_PRESETS[preset] });
});

els.reveal.addEventListener("click", async () => {
  if (!tab?.id) return;
  await chrome.tabs.sendMessage(tab.id, { type: MSG.REVEAL_ALL }).catch(() => {});
  window.close();
});

els.settings.addEventListener("click", () => chrome.runtime.openOptionsPage());

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  hostname = parseHostname(tab?.url || "");
  await refresh();
})();
