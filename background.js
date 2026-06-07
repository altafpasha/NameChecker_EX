// Reset enabled state on every browser startup so the extension is always ON when browser opens.
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.set({ extensionEnabled: true });
});

// Open welcome page on initial installation
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({
      url: chrome.runtime.getURL('welcome.html')
    });
  }
});
