const enabled = document.querySelector("#enabled");
const status = document.querySelector("#status");

chrome.storage.sync.get({ enabled: true }, (settings) => {
  enabled.checked = settings.enabled;
});

enabled.addEventListener("change", () => {
  chrome.storage.sync.set({ enabled: enabled.checked });
  status.textContent = enabled.checked ? "המסנן הופעל" : "המסנן הושהה";
});

document.querySelector("#settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
