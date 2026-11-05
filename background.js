// Reset enabled state on every browser startup so the extension is always ON when browser opens.
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.set({ extensionEnabled: true });
  // Clean up any legacy transient customer data to prevent cross-customer leakage
  chrome.storage.local.remove(['savedProfileName', 'savedProfilePAN']);
});

// Open welcome page on initial installation
chrome.runtime.onInstalled.addListener((details) => {
  // Clean up any legacy transient customer data
  chrome.storage.local.remove(['savedProfileName', 'savedProfilePAN']);
  if (details.reason === 'install') {
    chrome.tabs.create({
      url: chrome.runtime.getURL('welcome.html')
    });
  }
});

// Provide open tabs / pages query service to welcome page and popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "GET_OPEN_TABS") {
    if (chrome.tabs && chrome.tabs.query) {
      chrome.tabs.query({}, (tabs) => {
        const detected = (tabs || [])
          .filter(t => t.url && (t.url.startsWith("http://") || t.url.startsWith("https://")))
          .map(t => {
            try {
              const u = new URL(t.url);
              return { url: t.url, hostname: u.hostname, title: t.title || u.hostname, id: t.id };
            } catch (_) {
              return null;
            }
          })
          .filter(Boolean);
        sendResponse({ success: true, tabs: detected });
      });
      return true; // Keep sendResponse channel open
    } else {
      sendResponse({ success: false, tabs: [] });
    }
  }
});

// Auto-detect URL / path changes (including SPA pushState and hash changes) across all tabs
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    chrome.tabs.sendMessage(tabId, {
      action: "URL_CHANGED",
      url: tab.url,
      status: changeInfo.status
    }).catch(() => {});
  }
});


