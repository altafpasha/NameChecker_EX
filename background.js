// Reset enabled state on every browser startup so the extension is always ON when browser opens.
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.set({ extensionEnabled: true });
});
