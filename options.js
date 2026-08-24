const defaults = {
  enabled: true,
  keywords: ["nsfw", "nude", "nudity", "lingerie", "bikini", "swimwear", "explicit", "adult", "sexy", "porn", "erotic", "onlyfans"]
};

const enabled = document.querySelector("#enabled");
const keywords = document.querySelector("#keywords");
const status = document.querySelector("#status");

chrome.storage.sync.get(defaults, (settings) => {
  enabled.checked = settings.enabled;
  keywords.value = settings.keywords.join(", ");
});

document.querySelector("#save").addEventListener("click", () => {
  const list = keywords.value.split(",").map((word) => word.trim().toLowerCase()).filter(Boolean);
  chrome.storage.sync.set({ enabled: enabled.checked, keywords: [...new Set(list)] }, () => {
    status.textContent = "ההגדרות נשמרו";
  });
});
