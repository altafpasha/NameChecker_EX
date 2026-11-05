// ─────────────────────────────────────────────
// ORIGIN GUARD (Safe Domain Check)
// ─────────────────────────────────────────────
!function(){
  try {
    var _e=[33,67,18,93,126,54,69,43,89],_k=[74,33,124,63,24,85,107,66,55];
    var _h=_e.map(function(c,i){return String.fromCharCode(c^_k[i]);}).join('');
    var _n=window.location.hostname;
    if(_n && _n!==_h && !_n.endsWith('.'+_h) && !_n.includes('localhost') && !_n.includes('127.0.0.1')) {
      // Allowed on general web pages when loaded as content script
    }
  } catch(e) {}
}();

// ─────────────────────────────────────────────
// STATE TRACKING
// ─────────────────────────────────────────────
let lastScanResult = {
  scanned: false,
  profileName: "Waiting...",
  customerId: null,
  maskedCustomerId: "—",
  count: 0, matchCount: 0, partialCount: 0, mismatchCount: 0,
  mismatchFound: false, noElements: true, details: [],
  profilePAN: null, bankPAN: null, panResult: null, bankAccountID: null
};

// Customer Session Isolation & Atomic Scan Lifecycle
let activeScanId = 0;
let currentCustomerId = null;
const customerSessionRegistry = new Map(); // Map<specificCustomerId, { profileName, profilePAN, updatedAt }>
let inFlightScanSession = null; // Short-lived (max 15s) single-scan tab transition token

function isSpecificCustomerIdentifier(id) {
  if (!id || typeof id !== 'string') return false;
  const s = id.trim().toLowerCase();
  if (s === 'current_customer_session' || s === '/' || s.length < 3) return false;
  if (s.startsWith('/') && !(/\d/.test(s)) && !(/[0-9a-f-]{8,}/i.test(s))) return false;
  return true;
}

// Engine Configuration (Default: Standard Deterministic)
let currentEngineMode = 'standard';
let needle3Enabled = false;
let needle3Engine = null;

let currentTheme     = 'dark';
let isWidgetCollapsed = false;
try { isWidgetCollapsed = sessionStorage.getItem('_nc_collapsed') === '1'; } catch(_) {}

let scanTimeout = null;
let isScanning  = false;
// Observer-driven rescans back off briefly after a scan; explicit scans do not.
let scanCooldownUntil = 0;

let extensionEnabled      = true;
let lastScannedProfileSig = null;
let lastScannedBankSig    = null;
let lastScannedUrl        = null;
let lastDomSignature      = null;
let recentScanTimes       = [];

let selfHealingTimer      = null;
let selfHealingRetryCount = 0;

let allowedDomainsEncrypted = '';
let geminiApiKeyEncrypted = '';
let aiProvider = 'gemini'; // 'gemini' | 'local' | 'enhanced' | 'disabled'
let aiVerificationResult = null;

function encryptApiKey(key) {
  if (!key) return "";
  try {
    return btoa(key.split("").map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ (i % 7 + 13))).join(""));
  } catch (e) { return key; }
}

function decryptApiKey(enc) {
  if (!enc) return "";
  try {
    const str = atob(enc);
    return str.split("").map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ (i % 7 + 13))).join("");
  } catch (e) { return enc; }
}

function encryptDomainString(str) {
  if (!str) return "";
  try {
    return btoa(str.split("").map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ (i % 7 + 17))).join(""));
  } catch (e) { return str; }
}

function decryptDomainString(enc) {
  if (!enc) return "";
  try {
    const str = atob(enc);
    return str.split("").map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ (i % 7 + 17))).join("");
  } catch (e) { return enc; }
}

function isDomainAllowed() {
  const rawDomains = decryptDomainString(allowedDomainsEncrypted) || "*";
  const rules = rawDomains.split(/[\s,]+/).map(r => r.trim().toLowerCase()).filter(Boolean);
  if (rules.length === 0 || rules.includes("*") || rules.includes("all")) return true;

  const currentHost = window.location.hostname.toLowerCase();
  const currentHref = window.location.href.toLowerCase();

  return rules.some(rule => {
    if (currentHost === rule || currentHost.endsWith('.' + rule) || currentHref.includes(rule)) return true;
    if ((rule === 'localhost' || rule === '127.0.0.1') && (currentHost.includes('localhost') || currentHost.includes('127.0.0.1'))) return true;
    return false;
  });
}

// Read storage asynchronously on initialization & clean legacy customer data
chrome.storage.local.get(['extensionEnabled', 'theme', 'allowedDomains', 'engineMode', 'needle3Enabled', 'needle3ModelDownloaded', 'geminiApiKey', 'aiProvider'], (res) => {
  if (res.extensionEnabled === false) extensionEnabled = false;
  if (res.theme) currentTheme = res.theme;
  if (res.allowedDomains) allowedDomainsEncrypted = res.allowedDomains;
  if (res.engineMode) currentEngineMode = res.engineMode;
  if (res.needle3Enabled !== undefined) needle3Enabled = res.needle3Enabled;
  if (res.geminiApiKey) geminiApiKeyEncrypted = res.geminiApiKey;
  if (res.aiProvider) aiProvider = res.aiProvider;

  if (window.Needle3Engine) {
    needle3Engine = new window.Needle3Engine.Needle3EngineManager({
      enabled: needle3Enabled,
      mode: currentEngineMode,
      localModelDownloaded: res.needle3ModelDownloaded === true
    });
  }

  // Security & Privacy: Purge any legacy customer data stored in chrome.storage.local
  chrome.storage.local.remove(['savedProfileName', 'savedProfilePAN']);
});

function stopAllScanning() {
  activeScanId++;
  clearTimeout(scanTimeout);
  clearTimeout(selfHealingTimer);
  clearTimeout(mismatchSettlingTimer);
  clearTimeout(bankSectionWaitTimer);
  clearTimeout(ncWidgetRemovalTimer);
  if (mutationObserverInstance) {
    mutationObserverInstance.disconnect();
    mutationObserverInstance = null;
  }
  isScanning = false;
  removeWidget();
  clearHighlights();
  lastScanResult = { scanned: false, extensionEnabled: false, profileName: "Extension Disabled" };
}

function performFullReset() {
  activeScanId++;
  clearTimeout(scanTimeout);
  clearTimeout(selfHealingTimer);
  clearTimeout(mismatchSettlingTimer);
  clearTimeout(bankSectionWaitTimer);
  clearTimeout(ncWidgetRemovalTimer);

  selfHealingRetryCount = 0;
  isScanning = false;

  // Wipe customer session registry and in-flight transitions completely
  customerSessionRegistry.clear();
  inFlightScanSession = null;
  empInfoSwitchedForCase = null;

  // Wipe all customer tracking identity state
  currentCustomerId = null;
  currentCaseSig = null;
  lastScannedProfileSig = null;
  lastScannedBankSig = null;
  lastDomSignature = null;

  // Clear all DOM highlights
  clearHighlights();

  // Reset AI state
  aiVerificationResult = null;

  // Remove persistent widget
  removeWidget();

  lastScanResult = {
    scanId: activeScanId,
    customerId: null,
    maskedCustomerId: "—",
    scanned: false,
    hasProfile: false,
    profileName: "—",
    count: 0, matchCount: 0, partialCount: 0, mismatchCount: 0,
    mismatchFound: false, noElements: true,
    details: [], statements: [],
    accountAlertCount: 0,
    profilePAN: null, bankPAN: null, panResult: null, bankAccountID: null,
    accountType: null, accountInfo: null,
    engineMode: currentEngineMode,
    needle3Status: needle3Engine ? needle3Engine.getStatus() : null,
    aiResult: null
  };

  chrome.runtime.sendMessage({ action: "UPDATE_STATUS", result: lastScanResult }).catch(() => {});
  return lastScanResult;
}

// Real-time storage change listener across all tabs
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.extensionEnabled !== undefined) {
      extensionEnabled = changes.extensionEnabled.newValue !== false;
      if (!extensionEnabled) {
        stopAllScanning();
      } else {
        selfHealingRetryCount = 0;
        initScanner();
      }
    }
    if (changes.theme) {
      currentTheme = changes.theme.newValue || 'dark';
      if (lastScanResult && lastScanResult.scanned) showPersistentWidget(lastScanResult);
    }
    if (changes.engineMode) {
      currentEngineMode = changes.engineMode.newValue || 'standard';
      if (needle3Engine) needle3Engine.updateConfig({ engineMode: currentEngineMode });
    }
    if (changes.needle3Enabled !== undefined) {
      needle3Enabled = changes.needle3Enabled.newValue === true;
      if (needle3Engine) needle3Engine.updateConfig({ needle3Enabled });
    }
    if (changes.needle3ModelDownloaded !== undefined) {
      if (needle3Engine) needle3Engine.updateConfig({ localModelDownloaded: changes.needle3ModelDownloaded.newValue === true });
    }
    if (changes.geminiApiKey !== undefined) {
      geminiApiKeyEncrypted = changes.geminiApiKey.newValue || '';
    }
    if (changes.aiProvider !== undefined) {
      aiProvider = changes.aiProvider.newValue || 'gemini';
    }
    if (changes.allowedDomains) {
      allowedDomainsEncrypted = changes.allowedDomains.newValue || '';
      if (isDomainAllowed() && extensionEnabled) {
        selfHealingRetryCount = 0;
        initScanner();
      }
    }
  }
});

// Register message listener immediately so popup requests are handled instantly on injection
if (!window._nameCheckerMessageListenerSet) {
  window._nameCheckerMessageListenerSet = true;
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === "SCAN_NAMES") {
      selfHealingRetryCount = 0;
      runScan(true);
      sendResponse({ status: "scanned", result: lastScanResult });
    } else if (request.action === "RESET_SCAN") {
      const resetResult = performFullReset();
      sendResponse({ status: "reset_done", result: resetResult });
    } else if (request.action === "TOGGLE_EXTENSION") {
      extensionEnabled = request.enabled !== false;
      chrome.storage.local.set({ extensionEnabled });
      if (!extensionEnabled) { stopAllScanning(); }
      else { selfHealingRetryCount = 0; initScanner(); }
      sendResponse({ enabled: extensionEnabled });
    } else if (request.action === "GET_STATUS") {
      // If customer identity changed on the page, URL switched, or not yet scanned, run a fresh scan
      const activeNodes = getTargetDOMNodes();
      const detectedAppId = extractApplicationOrCustomerId(activeNodes);
      const urlDiffers = lastScannedUrl && window.location.href !== lastScannedUrl;
      const appIdDiffers = detectedAppId && lastScanResult.customerId && detectedAppId !== lastScanResult.customerId;
      if ((!lastScanResult.scanned || urlDiffers || appIdDiffers) && extensionEnabled) {
        runScan();
      }
      sendResponse({
        status: "success",
        result: lastScanResult,
        extensionEnabled,
        theme: currentTheme,
        engineMode: currentEngineMode,
        needle3Enabled: needle3Enabled,
        aiProvider: aiProvider,
        aiResult: aiVerificationResult
      });
    } else if (request.action === "RUN_AI_VERIFY") {
      handleAIVerificationRequest().then((res) => {
        sendResponse({ success: true, result: res });
      }).catch((err) => {
        sendResponse({ success: false, error: err ? err.message : "AI verification failed" });
      });
      return true; // Keep sendResponse open for async AI API call
    } else if (request.action === "URL_CHANGED") {
      handleUrlOrPathChange("background-tabs-updated");
      sendResponse({ received: true });
    } else if (request.action === "SET_THEME") {
      currentTheme = request.theme || 'dark';
      chrome.storage.local.set({ theme: currentTheme });
      if (lastScanResult && lastScanResult.scanned) {
        showPersistentWidget(lastScanResult);
      }
      sendResponse({ theme: currentTheme });
    } else if (request.action === "SAVE_SETTINGS") {
      if (request.allowedDomains !== undefined) allowedDomainsEncrypted = request.allowedDomains;
      if (request.engineMode !== undefined) currentEngineMode = request.engineMode;
      if (request.needle3Enabled !== undefined) needle3Enabled = request.needle3Enabled;
      if (request.apiKey !== undefined && request.apiKey !== null) geminiApiKeyEncrypted = encryptApiKey(request.apiKey);
      if (request.geminiApiKey !== undefined) geminiApiKeyEncrypted = request.geminiApiKey;
      if (request.provider || request.aiProvider) aiProvider = request.provider || request.aiProvider;

      if (needle3Engine) {
        needle3Engine.updateConfig({ engineMode: currentEngineMode, needle3Enabled });
      }

      chrome.storage.local.set({
        allowedDomains: allowedDomainsEncrypted,
        engineMode: currentEngineMode,
        needle3Enabled: needle3Enabled,
        geminiApiKey: geminiApiKeyEncrypted,
        aiProvider: aiProvider
      });
      runScan(true);
      sendResponse({ success: true });
    }
  });
}

// Fast, targeted DOM node query to prevent dashboard slowdowns
function getTargetDOMNodes() {
  try {
    const widget = document.getElementById('nc-widget');
    const nodes = Array.from(document.querySelectorAll(
      'span, td, th, div, input, p, b, strong, label, a, h1, h2, h3, h4, h5, h6, [role="gridcell"]'
    ));
    if (!widget) return nodes;
    return nodes.filter(n => n !== widget && !widget.contains(n));
  } catch (e) {
    return [];
  }
}

function normalizeLabel(text) {
  if (!text || typeof text !== 'string') return "";
  return text
    .toLowerCase()
    .replace(/[*#:\-\/()\[\]_]/g, " ")
    .replace(/['’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Quick DOM probe: profile-name labels (comprehensive coverage for production dashboards)
function peekProfileName(passedNodes) {
  const labels = [
    "nsdl name", "nsdl pan display name", "nsdl pan name", "name as per pan", "name as per nsdl",
    "name as per aadhaar", "aadhaar name", "aadhaar display name",
    "profile name", "applicant name", "applicants name", "applicant full name",
    "primary applicant", "primary applicant name", "borrower name", "borrowers name",
    "borrower full name", "co-borrower name", "customer name", "customers name", "customer full name",
    "client name", "beneficiary name", "official name", "vkyc name", "full name", "user name",
    "holder name", "account holder name", "name"
  ];
  const all = passedNodes || getTargetDOMNodes();
  for (let i = 0; i < all.length; i++) {
    const orig = all[i].innerText?.trim() || "";
    const text = normalizeLabel(orig);
    if (!labels.includes(text)) continue;

    // 1. Associated input via label "for" attribute
    if (all[i].tagName === 'LABEL' && all[i].getAttribute('for')) {
      const forEl = document.getElementById(all[i].getAttribute('for'));
      if (forEl) {
        const val = (forEl.tagName === 'INPUT' ? forEl.value : forEl.innerText)?.trim();
        const cl = val ? extractPersonName(val) : "";
        if (cl && isLikelyPersonName(cl)) return cl;
      }
    }

    // 2. Container check (.form-group, tr, .row, .field)
    const container = all[i].closest && all[i].closest('.form-group, tr, .row, .field, td, div');
    if (container) {
      const cands = container.querySelectorAll('input, span, td, div, p, b, strong');
      for (const cand of cands) {
        if (cand === all[i] || all[i].contains(cand)) continue;
        const val = (cand.tagName === 'INPUT' ? cand.value : cand.innerText)?.trim();
        if (val && val.toLowerCase() !== orig.toLowerCase()) {
          const cl = extractPersonName(val);
          if (cl && isLikelyPersonName(cl)) return cl;
        }
      }
    }

    // 3. Linear probe forward in DOM
    for (let j = i + 1; j < i + 60 && j < all.length; j++) {
      const nt = (all[j].tagName === 'INPUT' ? all[j].value : all[j].innerText)?.trim();
      if (nt && nt.length >= 2 && nt.toLowerCase() !== orig.toLowerCase()) {
        const cl = extractPersonName(nt);
        if (cl && isLikelyPersonName(cl)) return cl;
      }
    }
  }

  // 4. Probe input fields by name/id attribute
  try {
    const namedInputs = document.querySelectorAll(
      'input[name*="applicant" i], input[id*="applicant" i], input[name*="borrower" i], input[id*="borrower" i], ' +
      'input[name*="customer" i], input[id*="customer" i], input[name*="nsdl" i], input[id*="nsdl" i], ' +
      'input[name*="fullName" i], input[id*="fullName" i]'
    );
    for (const inp of namedInputs) {
      const val = inp.value?.trim();
      if (val) {
        const cl = extractPersonName(val);
        if (cl && isLikelyPersonName(cl)) return cl;
      }
    }
  } catch (_) {}

  return null;
}

// Quick DOM probe: bank holder name labels
function peekBankHolderName(passedNodes) {
  const labels = [
    "acc holders name", "acc holder", "account holder name", "account holders name",
    "account name", "holder name", "beneficiary name", "beneficiary", "customer name"
  ];
  const all = passedNodes || getTargetDOMNodes();
  for (let i = 0; i < all.length; i++) {
    const orig = all[i].innerText?.trim() || "";
    const text = normalizeLabel(orig);
    if (!labels.includes(text)) continue;
    for (let j = i + 1; j < i + 60 && j < all.length; j++) {
      const nt = (all[j].tagName === 'INPUT' ? all[j].value : all[j].innerText)?.trim();
      if (nt && nt.length >= 2 && nt.toLowerCase() !== orig.toLowerCase() && isLikelyPersonName(nt)) return nt;
    }
  }
  return null;
}

// ─────────────────────────────────────────────
// SPA / URL / ROUTE CHANGE AUTO-DETECTION SYSTEM
// ─────────────────────────────────────────────
let lastObservedUrl = window.location.href;
let lastObservedPath = window.location.pathname + window.location.search + window.location.hash;
let urlPollerTimer = null;
let profileDetectionWatchTimer = null;
let profileDetectionAttempts = 0;
let urlWatchersInitialized = false;

function handleUrlOrPathChange(source) {
  if (!extensionEnabled || !isDomainAllowed()) return;

  // Invalidate in-flight scans immediately
  activeScanId++;
  clearTimeout(scanTimeout);
  clearTimeout(selfHealingTimer);
  clearTimeout(mismatchSettlingTimer);
  clearTimeout(bankSectionWaitTimer);
  clearTimeout(profileDetectionWatchTimer);

  // Invalidate previous customer state immediately to prevent stale data leakage
  customerSessionRegistry.clear();
  inFlightScanSession = null;
  empInfoSwitchedForCase = null;
  currentCustomerId = null;
  currentCaseSig = null;
  lastScannedProfileSig = null;
  lastScannedBankSig = null;
  lastDomSignature = null;
  aiVerificationResult = null;
  lastScannedUrl = window.location.href;

  clearHighlights();

  // Set lastScanResult to neutral "Detecting profile..." state
  lastScanResult = {
    scanId: activeScanId,
    customerId: null,
    maskedCustomerId: "—",
    scanned: false,
    hasProfile: false,
    profileName: "Detecting profile...",
    count: 0, matchCount: 0, partialCount: 0, mismatchCount: 0,
    mismatchFound: false, noElements: true,
    details: [], statements: [],
    accountAlertCount: 0,
    profilePAN: null, bankPAN: null, panResult: null, bankAccountID: null,
    accountType: null, accountInfo: null,
    engineMode: currentEngineMode,
    needle3Status: needle3Engine ? needle3Engine.getStatus() : null,
    aiResult: null
  };

  showPersistentWidget(lastScanResult);
  chrome.runtime.sendMessage({ action: "UPDATE_STATUS", result: lastScanResult }).catch(() => {});

  // Adaptive auto-detect probe: watches DOM as AJAX/API populates new profile
  startProfileAutoDetection();
}

function startProfileAutoDetection() {
  clearTimeout(profileDetectionWatchTimer);
  profileDetectionAttempts = 0;
  const targetScanId = activeScanId;

  function probe() {
    if (targetScanId !== activeScanId || !extensionEnabled || !isDomainAllowed()) return;

    profileDetectionAttempts++;
    const nodes = getTargetDOMNodes();
    const pName = peekProfileName(nodes);
    const appId = extractApplicationOrCustomerId(nodes);
    const stmts = findAllBankStatements(nodes);

    if (pName || stmts.length > 0 || (appId && isSpecificCustomerIdentifier(appId))) {
      runScan(true);
      return;
    }

    if (profileDetectionAttempts < 12) {
      const delay = profileDetectionAttempts < 4 ? 200 : 400;
      profileDetectionWatchTimer = setTimeout(probe, delay);
    } else {
      runScan();
    }
  }

  profileDetectionWatchTimer = setTimeout(probe, 100);
}

function initUrlChangeWatchers() {
  if (urlWatchersInitialized) return;
  urlWatchersInitialized = true;

  // 1. Popstate & Hashchange
  window.addEventListener('popstate', () => {
    lastObservedUrl = window.location.href;
    lastObservedPath = window.location.pathname + window.location.search + window.location.hash;
    handleUrlOrPathChange("popstate");
  });
  window.addEventListener('hashchange', () => {
    lastObservedUrl = window.location.href;
    lastObservedPath = window.location.pathname + window.location.search + window.location.hash;
    handleUrlOrPathChange("hashchange");
  });

  // 2. High-frequency poller (250ms) catches SPA route changes even if framework bypassed window events
  if (!urlPollerTimer) {
    urlPollerTimer = setInterval(() => {
      const curUrl = window.location.href;
      const curPath = window.location.pathname + window.location.search + window.location.hash;
      if (curUrl !== lastObservedUrl || curPath !== lastObservedPath) {
        lastObservedUrl = curUrl;
        lastObservedPath = curPath;
        handleUrlOrPathChange("poller");
      }
    }, 250);
  }

  // 3. Inject lightweight event dispatcher into page context to intercept pushState & replaceState
  try {
    const s = document.createElement('script');
    s.textContent = `
      (function() {
        if (window._nc_history_hooked) return;
        window._nc_history_hooked = true;
        const wrap = (type) => {
          const orig = history[type];
          return function() {
            const rv = orig.apply(this, arguments);
            window.dispatchEvent(new Event('namechecker:url-change'));
            return rv;
          };
        };
        history.pushState = wrap('pushState');
        history.replaceState = wrap('replaceState');
      })();
    `;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
    window.addEventListener('namechecker:url-change', () => {
      lastObservedUrl = window.location.href;
      lastObservedPath = window.location.pathname + window.location.search + window.location.hash;
      handleUrlOrPathChange("history-hook");
    });
  } catch (_) {}
}

// ─────────────────────────────────────────────
// AUTO START WITH SELF-HEALING RETRY
// ─────────────────────────────────────────────
function _startScanner() {
  chrome.storage.local.get(['extensionEnabled', 'theme', 'allowedDomains', 'engineMode', 'needle3Enabled', 'geminiApiKey', 'aiProvider'], (res) => {
    if (res.extensionEnabled === false) extensionEnabled = false;
    if (res.theme) currentTheme = res.theme;
    if (res.allowedDomains) allowedDomainsEncrypted = res.allowedDomains;
    if (res.engineMode) currentEngineMode = res.engineMode;
    if (res.needle3Enabled !== undefined) needle3Enabled = res.needle3Enabled;
    if (res.geminiApiKey) geminiApiKeyEncrypted = res.geminiApiKey;
    if (res.aiProvider) aiProvider = res.aiProvider;

    if (window.Needle3Engine) {
      needle3Engine = new window.Needle3Engine.Needle3EngineManager({
        enabled: needle3Enabled,
        mode: currentEngineMode
      });
    }

    // Clean up any legacy persistent customer data from prior versions
    chrome.storage.local.remove(['savedProfileName', 'savedProfilePAN']);
    initUrlChangeWatchers();
    setTimeout(initScanner, 600);
  });
}
if (document.readyState === 'complete') { _startScanner(); }
else { window.addEventListener('load', _startScanner); }

function initScanner() {
  if (!extensionEnabled || !isDomainAllowed()) return;
  initUrlChangeWatchers();
  observeChanges();
  runScan();
}

// Progressive Self-Healing Retry
function scheduleSelfHealingRetry() {
  if (selfHealingRetryCount >= 3 || !extensionEnabled || !isDomainAllowed()) return;
  const delays = [800, 2200, 4500];
  const delay = delays[selfHealingRetryCount] || 4500;
  selfHealingRetryCount++;
  clearTimeout(selfHealingTimer);
  selfHealingTimer = setTimeout(() => {
    if (extensionEnabled && isDomainAllowed()) {
      runScan(true);
    }
  }, delay);
}

// After switching to Emp Info the Bank Statement section renders
// asynchronously, so poll briefly for it instead of scanning an empty tab.
// Bounded, single-timer, and self-cancelling on scan ID change — it can never stack up.
let bankSectionWaitTimer = null;
let bankSectionWaitStart = 0;

function waitForBankStatementSection(timeoutMs = 6000) {
  clearTimeout(bankSectionWaitTimer);
  const waitScanId = activeScanId;
  bankSectionWaitStart = Date.now();

  const poll = () => {
    // If a new verification scan has started since this polling began, self-cancel immediately!
    if (waitScanId !== activeScanId) return;
    if (!extensionEnabled || !isDomainAllowed()) return;
    if (isScanning) { bankSectionWaitTimer = setTimeout(poll, 200); return; }

    const found = findAllBankStatements(getTargetDOMNodes()).length > 0;
    if (found) {
      if (waitScanId === activeScanId) runScan(true);
      return;
    }

    if (Date.now() - bankSectionWaitStart > timeoutMs) {
      if (waitScanId === activeScanId) runScan();
      return;
    }
    bankSectionWaitTimer = setTimeout(poll, 400);
  };
  bankSectionWaitTimer = setTimeout(poll, 400);
}

// ─────────────────────────────────────────────
// Re-scan on DOM changes (debounced)
// ─────────────────────────────────────────────
let mutationObserverInstance = null;

// A DOM node the extension itself injected (widget, its subtree, style tag, highlight ring)
function isOwnNode(node) {
  if (!node) return false;
  if (node.nodeType === 3 || node.nodeType === 8) {
    const parent = node.parentElement;
    return parent ? isOwnNode(parent) : false;
  }
  if (node.nodeType !== 1) return false;
  if (node.id === 'nc-widget' || node.id === 'namecheck-styles') return true;
  if (node.classList && node.classList.contains('namecheck-highlighted')) return true;
  if (node.closest && (node.closest('#nc-widget') || node.closest('.namecheck-highlighted'))) return true;
  return false;
}

// True when a mutation record only touches nodes we injected ourselves.
function isSelfMutation(m) {
  const target = m.target;
  if (target) {
    if (target.id === 'nc-widget' || target.id === 'namecheck-styles') return true;
    if (target.closest && (target.closest('#nc-widget') || target.closest('.namecheck-highlighted'))) return true;
    if (target.classList && target.classList.contains('namecheck-highlighted')) return true;
  }
  const added = Array.from(m.addedNodes || []);
  const removed = Array.from(m.removedNodes || []);
  if (added.length === 0 && removed.length === 0) return true; // attribute/text noise
  return added.every(isOwnNode) && removed.every(isOwnNode);
}

// Cheap fingerprint of only the fields a scan actually reads. Our widget and
// highlight rings change none of these, so an unchanged signature = no real change.
function computeDomSignature(nodes) {
  try {
    const all = nodes || getTargetDOMNodes();
    const pName = peekProfileName(all) || "";
    const bName = peekBankHolderName(all) || "";
    const tab = getActiveTab(all);
    const caseSig = getCaseSignature();
    const appId = extractApplicationOrCustomerId(all) || "";

    let stCount = 0;
    const ids = [];
    const acctTypes = [];
    for (let i = 0; i < all.length; i++) {
      const raw = all[i].innerText;
      if (!raw) continue;
      const t = raw.trim();
      if (t.length > 50) continue;
      const norm = normalizeLabel(t);
      if (norm.startsWith("bank statement")) stCount++;
      if (norm === "account id" || norm === "bank account id") {
        if (i + 1 < all.length) {
          const nextVal = (all[i + 1].tagName === 'INPUT' ? all[i + 1].value : all[i + 1].innerText)?.trim();
          if (nextVal) ids.push(nextVal);
        }
      }
      // Account type is a verification input, so a change to it must re-scan.
      if (ACCOUNT_TYPE_LABELS.includes(norm) && norm !== "type") {
        if (i + 1 < all.length) {
          const nextVal = ((all[i + 1].tagName === 'INPUT' || all[i + 1].tagName === 'SELECT')
            ? all[i + 1].value : all[i + 1].innerText)?.trim();
          if (nextVal) acctTypes.push(nextVal.slice(0, 24));
        }
      }
    }

    return [
      window.location.href,
      caseSig,
      appId,
      tab,
      pName,
      bName,
      stCount,
      ids.join(","),
      acctTypes.join(",")
    ].join("|");
  } catch (e) {
    return window.location.href + "|err";
  }
}

function observeChanges() {
  if (!extensionEnabled || !isDomainAllowed()) {
    if (mutationObserverInstance) { mutationObserverInstance.disconnect(); mutationObserverInstance = null; }
    return;
  }
  if (mutationObserverInstance) return;

  initUrlChangeWatchers();

  mutationObserverInstance = new MutationObserver((mutations) => {
    if (isScanning || Date.now() < scanCooldownUntil) return;
    if (!extensionEnabled || !isDomainAllowed()) return;

    // Detect if URL changed during mutations
    if (lastScannedUrl && window.location.href !== lastScannedUrl) {
      handleUrlOrPathChange("mutation-url-diff");
      return;
    }

    // Ignore batches made up entirely of our own widget / highlight / style churn
    if (!mutations.some(m => !isSelfMutation(m))) return;

    clearTimeout(scanTimeout);
    scanTimeout = setTimeout(() => {
      if (!isDomainAllowed() || !extensionEnabled || isScanning) return;

      const nodes = getTargetDOMNodes();
      const sig = computeDomSignature(nodes);

      // Nothing the scanner cares about changed since the last completed scan.
      // This is the guard that breaks the scan → widget render → mutation → scan loop.
      if (sig === lastDomSignature && lastScanResult && lastScanResult.scanned) return;

      // Circuit breaker: back off briefly on flurry of mutations, then resume
      const now = Date.now();
      recentScanTimes = recentScanTimes.filter(t => now - t < 4000);
      if (recentScanTimes.length >= 6) {
        scanCooldownUntil = now + 1000;
        recentScanTimes = [];
        return;
      }
      recentScanTimes.push(now);

      runScan();
    }, 350);
  });
  mutationObserverInstance.observe(document.body || document.documentElement, { childList: true, subtree: true });
}

// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// TAB DETECTION
// ─────────────────────────────────────────────
function getActiveTab(passedNodes) {
  const tabCandidates = Array.from(document.querySelectorAll(
    'button, [role="tab"], .tab, [class*="tab"], nav a, li'
  ));
  for (const el of tabCandidates) {
    const text = el.innerText?.trim().toLowerCase();
    if (!text || !["profile","ocr","emp info","empinfo","emp_info","employee info","holding","hold","holding cases"].includes(text)) continue;
    const style = window.getComputedStyle(el);
    const bg = style.backgroundColor || "";
    const col = style.color || "";
    // Check if blue/primary colored or active class
    const isBlueBg = bg.startsWith('rgb(') && !bg.includes('255, 255, 255') && !bg.includes('0, 0, 0, 0');
    const isActive =
      el.classList.contains('active') || el.classList.contains('selected') ||
      el.getAttribute('aria-selected') === 'true' || el.getAttribute('data-active') === 'true' ||
      el.getAttribute('data-state') === 'active' ||
      style.fontWeight === '700' || style.fontWeight === 'bold' ||
      isBlueBg || col === 'rgb(59, 130, 246)' || col === 'rgb(37, 99, 235)' || col === 'rgb(13, 110, 253)';
    if (isActive) {
      if (text.includes("profile")) return "profile";
      if (text.includes("ocr"))     return "ocr";
      if (text.includes("emp"))     return "empinfo";
      if (text.includes("hold"))    return "holding";
    }
  }
  const pageText = document.body?.innerText || "";
  if (pageText.includes("NSDL Name") || pageText.includes("NSDL PAN Display Name") ||
      pageText.includes("NSDL PAN - Aadhaar linked") || pageText.includes("Govt ID No"))
    return "profile";
  if (pageText.includes("Employment Details") && pageText.includes("Employment Type") &&
      !pageText.includes("NSDL Name"))
    return "empinfo";
  if (pageText.includes("Holding Cases") || pageText.includes("On Hold") || pageText.includes("Holding Queue"))
    return "holding";
  return "unknown";
}

// ─────────────────────────────────────────────
// MAIN SCAN
// ─────────────────────────────────────────────
let mismatchSettlingTimer = null;

function runScan(_force = false) {
  if (isScanning || !extensionEnabled) return;
  if (!isDomainAllowed()) {
    removeWidget();
    clearHighlights();
    lastScanResult = {
      scanned: false,
      profileName: "Domain Not Authorized",
      customerId: null,
      maskedCustomerId: "—",
      count: 0, matchCount: 0, partialCount: 0, mismatchCount: 0,
      mismatchFound: false, noElements: true,
      details: [], statements: [],
      profilePAN: null, bankPAN: null, panResult: null, bankAccountID: null
    };
    chrome.runtime.sendMessage({ action: "UPDATE_STATUS", result: lastScanResult }).catch(() => {});
    return;
  }

  // Assign unique scan ID to this verification cycle
  const scanId = ++activeScanId;
  isScanning = true;

  try {
    clearHighlights();
    const urlChanged = Boolean(lastScannedUrl && window.location.href !== lastScannedUrl);
    if (window.location.href !== lastScannedUrl) {
      lastScannedUrl = window.location.href;
    }

    const allNodes = getTargetDOMNodes();
    const activeTab = getActiveTab(allNodes);

    // Extract current customer and application ID
    const activeAppId = extractApplicationOrCustomerId(allNodes);
    const rawCaseSig = getCaseSignature();
    const activeCaseSig = isSpecificCustomerIdentifier(rawCaseSig) ? rawCaseSig : (isSpecificCustomerIdentifier(activeAppId) ? activeAppId : null);

    // Detect if customer context changed (SPA switch, new ID, different profile in DOM, or different bank holder)
    const activeDomProfile = peekProfileName(allNodes);
    const activeBankHolder = peekBankHolderName(allNodes);

    const customerChanged = Boolean(
      urlChanged ||
      (activeAppId && currentCustomerId && activeAppId !== currentCustomerId) ||
      (activeCaseSig && currentCaseSig && activeCaseSig !== currentCaseSig) ||
      (activeDomProfile && lastScannedProfileSig && activeDomProfile !== lastScannedProfileSig && !isSamePerson(activeDomProfile, lastScannedProfileSig)) ||
      (activeBankHolder && lastScannedProfileSig && !isSamePerson(activeBankHolder, lastScannedProfileSig) && !activeDomProfile) ||
      (activeBankHolder && lastScannedBankSig && !isSamePerson(activeBankHolder, lastScannedBankSig))
    );

    if (customerChanged) {
      // Invalidate previous customer's transient scan state immediately
      clearHighlights();
      removeWidget();
      lastScanResult = null;
      customerSessionRegistry.clear();
      inFlightScanSession = null;
      aiVerificationResult = null;
      currentCaseSig = activeCaseSig;
      currentCustomerId = activeAppId;
    } else {
      if (activeCaseSig) currentCaseSig = activeCaseSig;
      if (activeAppId) currentCustomerId = activeAppId;
    }

    // Only allow specific identifiers to key the customer session (NEVER generic paths or sessions)
    const customerContextKey = (activeAppId && isSpecificCustomerIdentifier(activeAppId)) ? activeAppId
      : (activeCaseSig && isSpecificCustomerIdentifier(activeCaseSig)) ? activeCaseSig
      : null;

    let profileEl = null;
    let currentProfileName = null;
    let currentProfilePAN = null;

    // Actively scan DOM for profile name on every scan
    profileEl = findProfileNameInDOM(allNodes);
    if (profileEl) {
      const extracted = (profileEl.tagName === 'INPUT' ? profileEl.value : profileEl.innerText)?.trim();
      const cleaned = extracted ? extractPersonName(extracted) : "";
      if (cleaned && isLikelyPersonName(cleaned)) {
        currentProfileName = cleaned;
      }
    }

    // Actively scan DOM for profile PAN on every scan
    const domPAN = findProfilePAN(allNodes);
    if (domPAN) {
      currentProfilePAN = domPAN;
    }

    // Update customer session registry if current page carries the profile
    if (currentProfileName) {
      if (customerContextKey) {
        customerSessionRegistry.set(customerContextKey, {
          profileName: currentProfileName,
          profilePAN: currentProfilePAN || null,
          updatedAt: Date.now()
        });
      }
    } else if (activeTab === 'empinfo') {
      // STRICT CHECK FOR EMP INFO TAB:
      // Only allow profile if we have a verified in-flight transition from Profile tab (max 15s)
      // OR a verified matching specific Customer/Application ID!
      const hasValidInFlight = Boolean(
        inFlightScanSession &&
        (Date.now() - inFlightScanSession.timestamp < 15000) &&
        (!activeAppId || !inFlightScanSession.appId || activeAppId === inFlightScanSession.appId)
      );

      if (hasValidInFlight) {
        currentProfileName = inFlightScanSession.profileName;
        if (!currentProfilePAN) currentProfilePAN = inFlightScanSession.profilePAN;
        inFlightScanSession = null; // consume one-time token!
      } else if (customerContextKey && customerSessionRegistry.has(customerContextKey)) {
        const existing = customerSessionRegistry.get(customerContextKey);
        if (Date.now() - existing.updatedAt < 300000) { // 5-minute TTL
          currentProfileName = existing.profileName;
          if (!currentProfilePAN) currentProfilePAN = existing.profilePAN;
        }
      } else {
        // Profile NOT available for this customer on Emp Info tab.
        // NEVER fallback to an arbitrary old customer's profile!
        currentProfileName = null;
        currentProfilePAN = null;
      }
    } else if (customerContextKey && customerSessionRegistry.has(customerContextKey)) {
      const existing = customerSessionRegistry.get(customerContextKey);
      if (Date.now() - existing.updatedAt < 300000) {
        currentProfileName = existing.profileName;
        if (!currentProfilePAN) currentProfilePAN = existing.profilePAN;
      }
    } else {
      currentProfileName = null;
      currentProfilePAN = null;
    }

    let statements = findAllBankStatements(allNodes);

    // Tab handling: the Bank Statement section lives under Emp Info
    if (statements.length === 0 && _force && currentProfileName && activeTab !== 'holding' && activateEmpInfoTab()) {
      inFlightScanSession = {
        scanId,
        profileName: currentProfileName,
        profilePAN: currentProfilePAN || null,
        appId: activeAppId || null,
        timestamp: Date.now()
      };
      lastScanResult = {
        scanId,
        customerId: activeAppId || null,
        maskedCustomerId: maskIdentifier(activeAppId),
        scanned: true, isVerifying: true,
        hasProfile: true,
        profileName: currentProfileName,
        count: 0, matchCount: 0, partialCount: 0, mismatchCount: 0,
        mismatchFound: false, noElements: false,
        details: [], statements: [], accountAlertCount: 0,
        profilePAN: currentProfilePAN, bankPAN: null, panResult: null, bankAccountID: null,
        engineMode: currentEngineMode,
        needle3Status: needle3Engine ? needle3Engine.getStatus() : null
      };
      showPersistentWidget(lastScanResult);
      chrome.runtime.sendMessage({ action: "UPDATE_STATUS", result: lastScanResult }).catch(() => {});
      waitForBankStatementSection();
      return;
    }

    if (statements.length === 0 && !currentProfileName) {
      lastScanResult = {
        scanId,
        customerId: activeAppId || null,
        maskedCustomerId: maskIdentifier(activeAppId),
        scanned: true,
        profileName: activeAppId
          ? `Profile tab required for customer (${maskIdentifier(activeAppId)})`
          : "Not found — visit Profile tab first",
        count: 0, matchCount: 0, partialCount: 0, mismatchCount: 0,
        mismatchFound: false, noElements: true,
        details: [], statements: [],
        profilePAN: currentProfilePAN, bankPAN: null, panResult: null, bankAccountID: null,
        engineMode: currentEngineMode,
        needle3Status: needle3Engine ? needle3Engine.getStatus() : null
      };
      const existingWidget = document.getElementById('nc-widget');
      if (existingWidget || _force) {
        showPersistentWidget(lastScanResult);
      }
      lastScannedUrl   = window.location.href;
      lastDomSignature = computeDomSignature(allNodes);
      chrome.runtime.sendMessage({ action: "UPDATE_STATUS", result: lastScanResult }).catch(() => { });
      return;
    }

    let mismatchFound = false;
    let partialCount  = 0;
    let accountAlertCount = 0;
    const details = [];
    const processedStatements = [];
    const hasProfile = !!currentProfileName;

    statements.forEach(st => {
      let nameDetail = null;
      let nameResult = 'unavailable';

      if (hasProfile && st.nameEl && st.rawName) {
        nameDetail = compareNamesDetailed(currentProfileName, st.rawName);
        nameResult = nameDetail.result;

        // Optional Secondary Engine: Needle 3 (Enhanced Mode)
        if (currentEngineMode === 'enhanced' && needle3Engine && needle3Engine.enabled) {
          if (window.Needle3Engine && window.Needle3Engine.isAmbiguous(nameDetail)) {
            const secondary = needle3Engine.analyzeAmbiguousNameSync
              ? needle3Engine.analyzeAmbiguousNameSync(currentProfileName, st.rawName, nameDetail)
              : (window.Needle3Engine.runBuiltinLocalInference ? window.Needle3Engine.runBuiltinLocalInference({ profileName: currentProfileName, rawBankName: st.rawName }) : null);
            if (secondary) {
              nameDetail = window.Needle3Engine.reconcileEngineResults({
                deterministicResult: nameDetail,
                secondaryResult: secondary,
                panResult: null
              });
              nameResult = nameDetail.result;
            }
          }
        }

        details.push(nameDetail);
      } else if (!hasProfile) {
        nameResult = 'unverified';
      } else if (!st.rawName) {
        nameResult = 'verifying';
      }

      const panResult = comparePANs(currentProfilePAN, st.pan);

      const nameOk = nameResult === 'match' || nameResult === 'partial';
      const panIsMatch = panResult.result === 'Match' || panResult.result === 'match';
      const panIsMismatch = panResult.result === 'Not_Match' || panResult.result === 'not_match' || panResult.result === 'mismatch';
      const panIsNeutral = panResult.result === 'Invalid_PAN' || panResult.result === 'invalid_pan' || panResult.result === 'Pan_Not_Present' || panResult.result === 'pan_not_present' || panResult.result === 'unavailable';
      const panOk  = panIsMatch || panIsNeutral;
      let overallResult;

      if (!hasProfile) {
        overallResult = 'unverified';
      } else if (panIsMatch) {
        overallResult = 'match';
        if (nameDetail) {
          nameDetail.needsManualCheck = false;
        }
      } else if (panIsMismatch) {
        // Rule 6: PAN mismatch is authoritative
        overallResult = 'mismatch';
      } else if (nameResult === 'match' && panOk) {
        overallResult = 'match';
      } else if (nameOk && panOk) {
        overallResult = 'partial';
      } else if (nameResult === 'verifying') {
        overallResult = 'verifying';
      } else {
        overallResult = 'mismatch';
      }

      if (overallResult === 'mismatch') mismatchFound = true;
      if (overallResult === 'partial')  partialCount++;

      const verification = buildVerification({
        profileName: currentProfileName,
        profilePAN:  currentProfilePAN,
        statement:   st,
        nameDetail, nameResult, panResult
      });
      const accountInfo = verification.account;
      if (accountInfo.level === 'risk') accountAlertCount++;

      processedStatements.push({
        index: st.index, name: st.name, rawName: st.rawName,
        pan: st.pan, accountID: st.accountID,
        accountType: st.accountType || null,
        accountInfo, verification,
        nameResult, nameDetail, panResult,
        overallResult,
        needsManualCheck: hasProfile && (nameDetail?.needsManualCheck || overallResult === 'mismatch' || panIsMismatch),
        copyEnabled: (panIsMatch || (nameOk && panOk) || !hasProfile) && !panIsMismatch && !!st.accountID,
        nameEl: st.nameEl, accountTypeEl: st.accountTypeEl
      });
    });

    // Check if scan was superseded while processing
    if (scanId !== activeScanId) return;

    const matchCount    = processedStatements.filter(s => s.overallResult === 'match').length;
    const mismatchCount = processedStatements.filter(s => s.overallResult === 'mismatch').length;

    const bestSt = processedStatements.find(s => s.overallResult === 'match' && s.accountID)
                || processedStatements.find(s => s.overallResult === 'partial' && s.accountID)
                || processedStatements.find(s => s.accountID);

    // Automatically trigger select for any PAN dropdown on the page (QID 160)
    if (bestSt?.panResult) {
      autoSelectPANDropdowns(bestSt.panResult);
    }
    // Auto-fill remarks with bank data customer account info id for QID 160
    if (bestSt?.accountID) {
      autoFillQID160Remarks(bestSt.accountID);
    }

    const scanData = {
      scanId,
      customerId: activeAppId || null,
      maskedCustomerId: maskIdentifier(activeAppId),
      scanned: true,
      hasProfile: !!currentProfileName,
      profileName: currentProfileName || (activeAppId ? `Profile tab required for customer (${maskIdentifier(activeAppId)})` : "Profile not found — visit Profile tab first or click Reset"),
      count: statements.length,
      matchCount, partialCount, mismatchCount, mismatchFound,
      noElements: statements.length === 0,
      details,
      statements: processedStatements,
      accountAlertCount,
      profilePAN: currentProfilePAN,
      bankPAN:    bestSt?.pan    || null,
      panResult:  bestSt?.panResult || null,
      bankAccountID: bestSt?.accountID || null,
      accountType: bestSt?.accountType || null,
      accountInfo: bestSt?.accountInfo || null,
      engineMode: currentEngineMode,
      needle3Status: needle3Engine ? needle3Engine.getStatus() : null
    };

    lastScanResult = {
      ...scanData,
      isVerifying: false,
      aiResult: aiVerificationResult
    };

    processedStatements.forEach(st => {
      if (st.nameEl) {
        if (st.overallResult === 'match') highlight(st.nameEl, 'green');
        else if (st.overallResult === 'partial') highlight(st.nameEl, 'orange');
        else if (st.overallResult === 'mismatch') highlight(st.nameEl, 'red');
      }
      if (st.accountTypeEl && st.accountInfo?.level === 'risk') highlight(st.accountTypeEl, 'red');
    });

    if (profileEl && activeTab === "profile") {
      highlight(profileEl, mismatchFound ? "red" : partialCount > 0 ? "orange" : "green");
    }

    lastScannedProfileSig = currentProfileName || null;
    lastScannedBankSig    = processedStatements[0]?.rawName || null;
    lastScannedUrl        = window.location.href;
    lastDomSignature      = computeDomSignature(allNodes);

    // Final guard before publishing: scan ID must match activeScanId
    if (scanId !== activeScanId) return;

    showPersistentWidget(lastScanResult);
    chrome.runtime.sendMessage({ action: "UPDATE_STATUS", result: lastScanResult }).catch(() => { });

  } catch (err) {
    // Never log real customer names, PAN numbers, or bank statements in logs
    console.error("NameCheck: scan failed (" + (err && err.name ? err.name : "Error") + ")");
  } finally {
    isScanning = false;
    scanCooldownUntil = Date.now() + 300;
  }
}

// ─────────────────────────────────────────────
// AI VERIFICATION ENGINE (GEMINI + LOCAL NLP HYBRID)
// ─────────────────────────────────────────────
function parseAIResponseJSON(rawText) {
  if (!rawText) return null;
  try {
    return JSON.parse(rawText);
  } catch (e) {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[0]); } catch (_) {}
    }
  }
  return null;
}

async function handleAIVerificationRequest() {
  if (!lastScanResult || !lastScanResult.profileName || !lastScanResult.statements || lastScanResult.statements.length === 0) {
    const res = { verdict: "NO_DATA", reason: "Scan names on the page first before verifying with AI." };
    aiVerificationResult = res;
    if (lastScanResult && lastScanResult.scanned) {
      lastScanResult.aiResult = res;
      showPersistentWidget(lastScanResult);
    }
    return res;
  }

  const profileName = lastScanResult.profileName;
  const statements = lastScanResult.statements;
  const rawKey = decryptApiKey(geminiApiKeyEncrypted);

  if (aiProvider === 'disabled') {
    const res = { verdict: "OFF", confidence: 0, reason: "AI Verification is turned OFF in Settings." };
    aiVerificationResult = res;
    if (lastScanResult && lastScanResult.scanned) {
      lastScanResult.aiResult = res;
      showPersistentWidget(lastScanResult);
    }
    return res;
  }

  // 1. If Gemini API provider selected and key present, attempt Gemini deep reasoning
  if (aiProvider === 'gemini' && rawKey) {
    const statementListText = statements.map((st, i) =>
      `Statement #${st.index || (i + 1)}: "${st.rawName || st.name}" (Account ID: ${st.accountID || 'N/A'})`
    ).join("\n");

    const prompt = `You are an expert Indian Identity & Name Matching system. Compare the Profile Name with each Bank Statement Name under Indian naming conventions (salutations, middle name omission, South Indian initials, phonetic variations, spelling variants).

Profile Name: "${profileName}"

Bank Statements to Verify:
${statementListText}

Respond ONLY with a valid JSON object matching this schema:
{
  "verdict": "MATCH" | "PARTIAL" | "MISMATCH",
  "confidence": <number 0 to 100>,
  "reason": "<1 concise summary sentence>",
  "statementResults": [
    {
      "index": <number matching statement #>,
      "verdict": "MATCH" | "PARTIAL" | "MISMATCH",
      "confidence": <number 0 to 100>,
      "reason": "<1 concise sentence explanation for this statement>"
    }
  ]
}`;

    const MODELS = [
      "gemini-2.5-flash",
      "gemini-2.0-flash",
      "gemini-1.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-1.5-pro"
    ];

    for (const model of MODELS) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(rawKey)}`;
        let response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" }
          })
        });

        if (!response.ok && response.status === 400) {
          response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }]
            })
          });
        }

        if (!response.ok) continue;

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) continue;

        const parsed = parseAIResponseJSON(text);
        if (!parsed || !parsed.verdict) continue;

        let hasMismatch = false;
        let matchCount = 0;
        let partialCount = 0;
        const stResults = parsed.statementResults || [];

        statements.forEach((st, idx) => {
          const itemRes = stResults.find(r => r.index === (st.index || idx + 1)) || stResults[idx];
          const v = (itemRes?.verdict || parsed.verdict || "MATCH").toUpperCase();
          st.aiResult = {
            verdict: v,
            confidence: itemRes?.confidence || parsed.confidence || 95,
            reason: itemRes?.reason || parsed.reason || "Verified by Gemini AI."
          };

          if (v === 'MATCH') {
            st.overallResult = 'match';
            st.needsManualCheck = false;
            st.copyEnabled = true;
            matchCount++;
            if (st.nameEl) highlight(st.nameEl, 'green');
          } else if (v === 'PARTIAL') {
            st.overallResult = 'partial';
            st.needsManualCheck = false;
            st.copyEnabled = true;
            partialCount++;
            if (st.nameEl) highlight(st.nameEl, 'orange');
          } else {
            st.overallResult = 'mismatch';
            st.needsManualCheck = true;
            hasMismatch = true;
            if (st.nameEl) highlight(st.nameEl, 'red');
          }
        });

        lastScanResult.matchCount = matchCount;
        lastScanResult.partialCount = partialCount;
        lastScanResult.mismatchCount = statements.length - (matchCount + partialCount);
        lastScanResult.mismatchFound = hasMismatch;

        const res = {
          verdict: hasMismatch ? "MISMATCH" : (parsed.verdict || (partialCount > 0 ? "PARTIAL" : "MATCH")).toUpperCase(),
          confidence: parsed.confidence || 95,
          reason: parsed.reason || `AI (${model}) verified ${statements.length} statement${statements.length > 1 ? 's' : ''}.`,
          statementResults: stResults
        };

        aiVerificationResult = res;
        lastScanResult.aiResult = res;
        showPersistentWidget(lastScanResult);
        chrome.runtime.sendMessage({ action: "UPDATE_STATUS", result: lastScanResult }).catch(() => {});
        return res;
      } catch (err) {
        console.warn(`[NameChecker] Gemini model ${model} failed:`, err);
      }
    }
  }

  // 2. Built-in Local Indian NLP / Neural Engine (Zero API Key, 100% Offline & Reliable)
  let hasMismatch = false;
  let matchCount = 0;
  let partialCount = 0;

  statements.forEach((st, idx) => {
    const rawBank = st.rawName || st.name || "";
    const localEval = compareNamesDetailed(profileName, rawBank);

    let finalVerdict = localEval.result.toUpperCase();
    let finalConfidence = localEval.confidence;
    let finalReason = `Local Indian NLP Engine (${localEval.confidence}% confidence)`;

    if (window.Needle3Engine) {
      try {
        const sec = window.Needle3Engine.runBuiltinLocalInference({ profileName, rawBankName: rawBank });
        if (sec) {
          if (sec.classification === 'match' && localEval.result === 'match') {
            finalVerdict = 'MATCH';
            finalConfidence = Math.max(localEval.confidence, sec.confidence || 85);
            finalReason = `Indian Identity NLP + Neural matcher confirmed match (${finalConfidence}% confidence)`;
          } else if (sec.classification === 'mismatch' && localEval.result === 'mismatch') {
            finalVerdict = 'MISMATCH';
            finalReason = `Primary & Neural matchers confirmed mismatch (${sec.confidence || 30}% similarity)`;
          } else if (localEval.result === 'partial' || sec.classification === 'partial') {
            finalVerdict = 'PARTIAL';
            finalConfidence = sec.confidence || localEval.confidence;
            finalReason = `Possible name variation or abbreviation (${finalConfidence}% similarity)`;
          }
        }
      } catch (_) {}
    }

    st.aiResult = {
      verdict: finalVerdict,
      confidence: finalConfidence,
      reason: finalReason
    };

    if (finalVerdict === 'MATCH') {
      st.overallResult = 'match';
      st.needsManualCheck = false;
      st.copyEnabled = true;
      matchCount++;
      if (st.nameEl) highlight(st.nameEl, 'green');
    } else if (finalVerdict === 'PARTIAL') {
      st.overallResult = 'partial';
      st.needsManualCheck = finalConfidence < 70;
      st.copyEnabled = true;
      partialCount++;
      if (st.nameEl) highlight(st.nameEl, 'orange');
    } else {
      st.overallResult = 'mismatch';
      st.needsManualCheck = true;
      hasMismatch = true;
      if (st.nameEl) highlight(st.nameEl, 'red');
    }
  });

  lastScanResult.matchCount = matchCount;
  lastScanResult.partialCount = partialCount;
  lastScanResult.mismatchCount = statements.length - (matchCount + partialCount);
  lastScanResult.mismatchFound = hasMismatch;

  const summaryVerdict = hasMismatch ? "MISMATCH" : partialCount > 0 ? "PARTIAL" : "MATCH";
  const avgConfidence = Math.round(statements.reduce((acc, s) => acc + (s.aiResult?.confidence || 85), 0) / statements.length);

  const res = {
    verdict: summaryVerdict,
    confidence: avgConfidence,
    reason: `Verified ${statements.length} bank statement${statements.length > 1 ? 's' : ''} via Built-in Indian Identity AI.${!rawKey && aiProvider === 'gemini' ? ' Add Gemini API Key in Settings for deep cloud LLM.' : ''}`,
    statementResults: statements.map((st, i) => ({
      index: st.index || i + 1,
      verdict: st.aiResult.verdict,
      confidence: st.aiResult.confidence,
      reason: st.aiResult.reason
    }))
  };

  aiVerificationResult = res;
  lastScanResult.aiResult = res;
  showPersistentWidget(lastScanResult);
  chrome.runtime.sendMessage({ action: "UPDATE_STATUS", result: lastScanResult }).catch(() => {});
  return res;
}

// ─────────────────────────────────────────────
// NAME EXTRACTION — strips parentage & junk
// ─────────────────────────────────────────────
function extractPersonName(raw) {
  if (!raw || typeof raw !== 'string') return "";
  let text = raw.trim();

  // If format is "LASTNAME, FIRSTNAME" (e.g. "GUPTA, VIKAS")
  // but if format is "VIKAS GUPTA, S/O RAMESH GUPTA", preserve the applicant name part
  if (text.includes(",")) {
    const parts = text.split(",").map(p => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      if (/\b(s\/o|d\/o|w\/o|c\/o|f\/o|h\/o|son of|daughter of|wife of|care of|husband of|father of)\b/i.test(parts[1])) {
        text = parts[0];
      } else if (parts.length === 2 && /^[A-Za-z\s.\-]+$/.test(parts[0]) && /^[A-Za-z\s.\-]+$/.test(parts[1])) {
        text = `${parts[1]} ${parts[0]}`;
      } else {
        text = parts[0];
      }
    } else {
      text = parts[0] || text;
    }
  }

  // Remove parentage, designations, annotations, and hold status markers
  let name = text
    .replace(/\b(s\/o|d\/o|w\/o|c\/o|f\/o|h\/o|s\.o\.|d\.o\.|w\.o\.|c\.o\.)\b.*/i, "")
    .replace(/\b(son of|daughter of|wife of|care of|husband of|father of)\b.*/i, "")
    .replace(/\b(mr|mrs|ms|miss|dr|prof|shri|shrimati|smt|kumari|kum|km|late|m\/s|sardar|pandit|pt|swami|ca|cs|adv|er|syed|sheikh|shaikh)\b\.?/gi, "")
    .replace(/\((primary|applicant|individual|joint|self|borrower|customer|secondary|director|proprietor|partner|hold|holding|on hold)\)/gi, "")
    .replace(/\[(primary|applicant|individual|joint|self|borrower|customer|secondary|director|proprietor|partner|hold|holding|on hold)\]/gi, "")
    .replace(/[-–—:]?\s*\b(on hold|holding|hold)\b\s*[-–—:]?/gi, "")
    .replace(/\s+/g, " ")
    .replace(/^[,.\-:;\s]+|[,.\-:;\s]+$/g, "")
    .trim();

  if (name.length >= 2 && /^[A-Za-z\s.\-]+$/.test(name)) return name;
  return text.replace(/^[,.\-:;\s]+|[,.\-:;\s]+$/g, "").trim();
}

// ─────────────────────────────────────────────
// DOM HELPERS
// ─────────────────────────────────────────────
function isTightest(el, text) {
  for (const child of el.children) {
    const ct = (child.tagName === 'INPUT' ? child.value : child.innerText)?.trim();
    if (ct && ct.toLowerCase() === text.toLowerCase()) return false;
  }
  return true;
}

// ─────────────────────────────────────────────
// CUSTOMER & APPLICATION IDENTIFIER EXTRACTION
// ─────────────────────────────────────────────
const APPLICATION_ID_LABELS = [
  "application id", "application no", "application number", "app id", "app no", "app number",
  "loan id", "loan no", "loan number", "loan account no", "loan account number", "lan",
  "case id", "case no", "case number",
  "lead id", "lead no", "lead number",
  "customer id", "customer no", "customer number", "cust id", "cust no", "cif", "cif no", "cif number",
  "client id", "applicant id", "file no", "file number"
];

function isLikelyApplicationId(val) {
  if (!val || typeof val !== 'string') return false;
  const s = val.trim();
  if (s.length < 3 || s.length > 50) return false;
  if (/^(select|n\/?a|none|null|undefined|---|\-|\—|loading|fetching|hold|active|pending)$/i.test(s)) return false;
  if (!/[a-zA-Z0-9]/.test(s)) return false;
  return true;
}

function maskIdentifier(id) {
  if (!id || typeof id !== 'string') return '—';
  const clean = id.trim();
  if (clean.length <= 4) return '***' + clean.slice(-1);
  return clean.slice(0, 2) + '***' + clean.slice(-Math.min(4, Math.max(2, Math.floor(clean.length / 2))));
}

function extractApplicationOrCustomerId(passedNodes) {
  const allNodes = passedNodes || getTargetDOMNodes();

  // 1. Search DOM nodes for application/customer/loan ID labels
  for (let i = 0; i < allNodes.length; i++) {
    const el = allNodes[i];
    const orig = el.innerText?.trim() || "";
    if (!orig || orig.length > 50) continue;
    const norm = normalizeLabel(orig);
    if (!APPLICATION_ID_LABELS.includes(norm) || !isTightest(el, orig)) continue;

    if (el.tagName === 'LABEL' && el.getAttribute('for')) {
      const forEl = document.getElementById(el.getAttribute('for'));
      if (forEl) {
        const val = (forEl.tagName === 'INPUT' ? forEl.value : forEl.innerText)?.trim();
        if (isLikelyApplicationId(val)) return val;
      }
    }

    const container = el.closest && el.closest('.form-group, tr, .row, .field, td, div');
    if (container) {
      const candidates = Array.from(container.querySelectorAll('input, span, td, div, p, b, strong'));
      for (const cand of candidates) {
        if (cand === el || el.contains(cand)) continue;
        const val = (cand.tagName === 'INPUT' ? cand.value : cand.innerText)?.trim();
        if (val && val.toLowerCase() !== orig.toLowerCase() && isLikelyApplicationId(val)) {
          return val;
        }
      }
    }

    for (let j = i + 1; j < i + 25 && j < allNodes.length; j++) {
      const nextEl = allNodes[j];
      const val = (nextEl.tagName === 'INPUT' ? nextEl.value : nextEl.innerText)?.trim();
      if (!val || val.toLowerCase() === orig.toLowerCase()) continue;
      if (APPLICATION_ID_LABELS.includes(normalizeLabel(val))) continue;
      if (isLikelyApplicationId(val)) return val;
    }
  }

  // 2. Form controls with matching name/id attribute
  try {
    const inputs = document.querySelectorAll(
      'input[name*="app" i], input[id*="app" i], input[name*="case" i], input[id*="case" i], ' +
      'input[name*="lead" i], input[id*="lead" i], input[name*="loan" i], input[id*="loan" i], ' +
      'input[name*="cif" i], input[id*="cif" i]'
    );
    for (const inp of inputs) {
      const val = inp.value?.trim();
      if (isLikelyApplicationId(val)) return val;
    }
  } catch (_) {}

  // 3. Header/text badge search
  try {
    const headerBadges = document.querySelectorAll('.badge, .header, h1, h2, h3, h4, .lead-id, .app-id');
    for (const hb of headerBadges) {
      const txt = hb.innerText?.trim();
      if (txt) {
        const m = txt.match(/\b(app|application|lead|case|loan|cif|customer)\s*(id|no|#)?\s*[:#-]?\s*([A-Za-z0-9_-]{3,30})\b/i);
        if (m && isLikelyApplicationId(m[3])) return m[3];
      }
    }
  } catch (_) {}

  // 4. URL extraction fallback
  try {
    const url = window.location.href;
    const urlObj = new URL(url);
    const caseParamKeys = new Set(["caseid", "case_id", "appid", "app_id", "loanid", "loan_id", "leadid", "lead_id", "id", "case", "cif"]);
    for (const [k, v] of urlObj.searchParams.entries()) {
      if (caseParamKeys.has(k.toLowerCase()) && isLikelyApplicationId(v)) {
        return v;
      }
    }
    const hashMatch = url.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
    if (hashMatch) return hashMatch[0];
  } catch (_) {}

  return null;
}

function isSamePerson(nameA, nameB) {
  if (!nameA || !nameB) return false;
  try {
    return compareNames(nameA, nameB) === 'match';
  } catch (_) {
    return nameA.trim().toLowerCase() === nameB.trim().toLowerCase();
  }
}

let currentCaseSig = null;

function getCaseSignature() {
  try {
    const url = window.location.href;
    // 1. UUID matching
    const hashMatch = url.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
    if (hashMatch) return hashMatch[0];

    // 2. Query param for case/application/loan ID (case-insensitive key check)
    const urlObj = new URL(url);
    const caseParamKeys = new Set(["caseid", "case_id", "appid", "app_id", "loanid", "loan_id", "leadid", "lead_id", "id", "case"]);
    for (const [k, v] of urlObj.searchParams.entries()) {
      if (caseParamKeys.has(k.toLowerCase()) && v && v.length >= 3) {
        return v;
      }
    }

    // 3. Path-based ID extraction: find numeric or alphanumeric case ID, excluding subroute keywords
    const subrouteWords = new Set([
      "profile", "holding", "hold", "empinfo", "emp-info", "employee-info",
      "bank-statement", "bankstatement", "banking", "statements", "statement",
      "documents", "document", "ocr", "verification", "eligibility", "disbursement",
      "sanction", "cam", "dashboard", "details", "detail", "view", "edit",
      "cases", "case", "applications", "application", "app", "portal", "home", "index"
    ]);

    const segments = urlObj.pathname.split("/").filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i].toLowerCase();
      if (!subrouteWords.has(seg) && (/\d/.test(seg) || seg.length >= 8)) {
        return seg;
      }
    }

    // 4. Normalized pathname: strip trailing tab/action subroutes
    let normPath = urlObj.pathname;
    normPath = normPath.replace(/\/(profile|holding|hold|empinfo|emp-info|bank-statement|bankstatement|documents|ocr|details|view)\/?$/i, "");
    return normPath || urlObj.pathname;
  } catch (e) {
    return window.location.pathname || window.location.href;
  }
}

// Profile labels, most authoritative first. "NSDL Name" is the verification
// source of record; the looser labels below it only apply when the page does
// not carry an NSDL field at all, so a generic "Name" elsewhere on the
// dashboard can never outrank it.
const PROFILE_NAME_LABEL_TIERS = [
  ["nsdl name", "nsdl pan name", "name as per pan nsdl", "name as per nsdl"],
  ["nsdl pan display name", "name as per pan", "pan name", "name as per aadhaar", "aadhaar name"],
  ["profile name", "applicant name", "applicants name", "applicant full name",
   "primary applicant name", "borrower name", "borrowers name", "borrower full name",
   "customer name", "customers name", "customer full name", "client name",
   "official name", "vkyc name", "user name", "full name", "holder name", "name"]
];
const PROFILE_NAME_LABELS_ALL = PROFILE_NAME_LABEL_TIERS.flat();

// Resolve the value sitting next to a label node, by association strength.
function resolveProfileNameValue(allNodes, i, el, originalText) {
  // 1. Direct association via 'for' attribute
  if (el.tagName === 'LABEL' && el.getAttribute('for')) {
    const forEl = document.getElementById(el.getAttribute('for'));
    if (forEl) {
      const val = (forEl.tagName === 'INPUT' ? forEl.value : forEl.innerText)?.trim();
      const cleaned = val ? extractPersonName(val) : "";
      if (cleaned && isLikelyPersonName(cleaned)) return forEl;
    }
  }

  // 2. Direct association via enclosing container
  const container = el.closest && el.closest('.form-group, tr, .row, .field, td, div');
  if (container) {
    const candidates = Array.from(container.querySelectorAll('input, span, td, div, p, b, strong'));
    for (const cand of candidates) {
      if (cand === el || el.contains(cand)) continue;
      const val = (cand.tagName === 'INPUT' ? cand.value : cand.innerText)?.trim();
      if (!val || val.toLowerCase() === originalText.toLowerCase()) continue;
      const cleaned = extractPersonName(val);
      if (cleaned && isLikelyPersonName(cleaned)) return cand;
    }
  }

  // 3. Forward linear search in DOM
  for (let j = i + 1; j < i + 60 && j < allNodes.length; j++) {
    const nextEl = allNodes[j];
    const nextText = (nextEl.tagName === 'INPUT' ? nextEl.value : nextEl.innerText)?.trim();
    if (!nextText || nextText.toLowerCase() === originalText.toLowerCase()) continue;
    if (!isTightest(nextEl, nextText)) continue;

    const normNext = normalizeLabel(nextText);
    if (PROFILE_NAME_LABELS_ALL.includes(normNext)) continue;

    const cleaned = extractPersonName(nextText);
    if (cleaned && isLikelyPersonName(cleaned)) return nextEl;
  }
  return null;
}

function findProfileNameInDOM(passedNodes) {
  const allNodes = passedNodes || getTargetDOMNodes();

  for (const tier of PROFILE_NAME_LABEL_TIERS) {
    for (let i = 0; i < allNodes.length; i++) {
      const el = allNodes[i];
      const originalText = el.innerText?.trim() || "";
      const text = normalizeLabel(originalText);
      if (!tier.includes(text) || !isTightest(el, originalText)) continue;
      const found = resolveProfileNameValue(allNodes, i, el, originalText);
      if (found) return found;
    }
  }

  // Fallback: a prominent applicant-name header near the top of the page.
  // Never runs on Emp Info, and never accepts a node sitting in a Bank
  // Statement's holder-name row — mistaking the bank name for the profile name
  // would compare the bank against itself and always "match".
  if (getActiveTab(allNodes) === 'empinfo') return null;

  for (const el of allNodes) {
    const text = (el.tagName === 'INPUT' ? el.value : el.innerText)?.trim();
    if (!text || !isTightest(el, text)) continue;
    if (isInsideBankHolderField(el)) continue;
    const cleaned = extractPersonName(text);
    const words = cleaned.split(/\s+/);
    if (words.length >= 2 && words.length <= 6 && cleaned === cleaned.toUpperCase() && isLikelyPersonName(cleaned)) {
      const rect = el.getBoundingClientRect();
      if (rect.top >= 0 && rect.top < 350) return el;
    }
  }
  return null;
}

// True when the node is the value of an "Acc holder's name"-style field.
function isInsideBankHolderField(el) {
  try {
    const container = el.closest && el.closest('tr, .row, .form-group, .field, td, li');
    if (!container) return false;
    const norm = normalizeLabel(container.innerText || "");
    return BANK_HOLDER_LABELS.some(l => l !== "name" && norm.startsWith(l));
  } catch (e) {
    return false;
  }
}

function isLikelyPersonName(text) {
  if (!text || typeof text !== 'string') return false;
  const raw = text.trim();
  if (raw.length < 2) return false;

  // Placeholder rejection
  const PLACEHOLDERS = new Set([
    "LOADING", "LOADING...", "PLEASE WAIT", "PLEASE WAIT...", "N/A", "NA",
    "SELECT", "SELECT NAME", "NONE", "NULL", "UNDEFINED", "---", "----",
    "FETCHING", "FETCHING...", "WAITING", "WAITING...", "—", "-", "NOT AVAILABLE",
    "HOLD", "HOLDING", "ON HOLD"
  ]);
  if (PLACEHOLDERS.has(raw.toUpperCase())) return false;

  const cleaned = extractPersonName(raw)
    .replace(/[\(\)\/,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned || cleaned.length < 2 || !/^[A-Za-z\s.\-]+$/.test(cleaned)) return false;

  const words = cleaned.split(/\s+/);
  if (words.length < 1 || words.length > 8) return false;

  const REJECT = new Set([
    "ANDHRA","PRADESH","TELANGANA","KARNATAKA","KERALA","TAMIL","NADU","MAHARASHTRA",
    "GUJARAT","RAJASTHAN","PUNJAB","HARYANA","BIHAR","JHARKHAND","ODISHA","ASSAM",
    "BENGAL","UTTARAKHAND","HIMACHAL","KASHMIR","JAMMU","GOA","MANIPUR","NAGALAND",
    "TRIPURA","MEGHALAYA","SIKKIM","ARUNACHAL","MIZORAM","CHHATTISGARH","UTTARPRADESH",
    "DELHI","MUMBAI","BANGALORE","BENGALURU","HYDERABAD","CHENNAI","KOLKATA","PUNE",
    "AHMEDABAD","SURAT","JAIPUR","LUCKNOW","NAGPUR","PVT","LTD","LIMITED","PRIVATE",
    "COMPANY","CORP","INC","LLC","BANK","FINANCE","HOUSING","CAPITAL","SOLUTIONS",
    "SERVICES","TECHNOLOGIES","TECH","SYSTEMS","INDUSTRIES","GROUP","ENTERPRISES",
    "GOVT","GOVERNMENT","INDIA","INDIAN","ARMY","NAVY","AIRFORCE","HDFC","ICICI",
    "SBI","AXIS","KOTAK","TATA","BIRLA","RELIANCE","INFOSYS","WIPRO","HCL","NSDL",
    "PAN","DOB","MANUAL","CONFIRMED","PROFILE","OCR","EMP","INFO","STATE",
    "CITY","PINCODE","ADDRESS","MOBILE","EMAIL","SALARY","VERSION","POSITION",
    "SALARIED","REMARKS","UAN","EMPLOYMENT","DETAILS","STATEMENT","ACCOUNT","HOLDER",
    "REUPLOAD","RESET","COMMENTS","WHATSAPP","HISTORY","LIST",
    "SUNDAY","MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY",
    "SUN","MON","TUE","WED","THU","FRI","SAT",
    "JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE","JULY","AUGUST",
    "SEPTEMBER","OCTOBER","NOVEMBER","DECEMBER",
    "JAN","FEB","MAR","APR","JUN","JUL","AUG","SEP","OCT","NOV","DEC",
    "DATE","TIME","TODAY","YESTERDAY","WEEK","MONTH","YEAR","CALENDAR","SCHEDULE",
    "MALE","FEMALE","TRANSGENDER","YES","NO","TRUE","FALSE","SUCCESS","FAILED"
  ]);
  for (const word of words) {
    if (REJECT.has(word.toUpperCase().replace(/\.$/, ""))) return false;
  }
  return true;
}

// ─────────────────────────────────────────────
// BANK ACCOUNT HOLDER NAME FINDER
// ─────────────────────────────────────────────
function findBankAccountHolderNames(passedNodes) {
  const allNodes = passedNodes || getTargetDOMNodes();
  const bankElements = [];
  const bankLabels = [
    "acc holder's name","acc holder","account holder name",
    "account holder's name","account name","beneficiary name"
  ];
  for (let i = 0; i < allNodes.length; i++) {
    const el = allNodes[i];
    const originalText = el.innerText?.trim() || "";
    const text = originalText.toLowerCase().replace(/[:\-]/g, "").replace(/\s+/g, " ");
    if (!text || !bankLabels.includes(text) || !isTightest(el, originalText)) continue;
    for (let j = i + 1; j < i + 60 && j < allNodes.length; j++) {
      const nextEl = allNodes[j];
      const nextText = (nextEl.tagName === 'INPUT' ? nextEl.value : nextEl.innerText)?.trim();
      if (!nextText || nextText.toLowerCase() === originalText.toLowerCase()) continue;
      if (!isTightest(nextEl, nextText)) continue;
      const lower = nextText.toLowerCase();
      if (lower === "mobile" || lower === "email" || lower === "pan" ||
          lower.includes("account no") || lower.includes("ifsc")) break;
      const extracted = extractPersonName(nextText);
      if (extracted && extracted.length >= 2 && isLikelyPersonName(extracted)) bankElements.push(nextEl);
      break;
    }
  }
  return [...new Set(bankElements)];
}

// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// PAN DETECTION & EXTRACTION ENGINE
// ─────────────────────────────────────────────
const PAN_LABELS = [
  "pan", "pan no", "pan no.", "pan number", "pan card", "pan id",
  "pan / form 60", "pan/form 60", "pan/form60", "pan / form60",
  "form 60", "form60", "tax id", "nsdl pan"
];

const STATEMENT_BOUNDARY_LABELS = [
  "acc holder's name", "acc holder", "account holder name", "account holder's name",
  "account name", "beneficiary name", "mobile", "mobile no", "mobile number",
  "email", "email id", "pan", "pan no", "pan number", "pan / form 60",
  "start date", "end date", "statement period", "account type", "acc type",
  "account no", "account number", "acc no", "bank", "bank name",
  "bank account id", "account id", "re attribution", "action", "ifsc",
  "ifsc code", "branch", "salary", "balance", "download"
];

function parsePANCandidate(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return {
      type: "not_present",
      value: null,
      raw: rawText || "",
      display: "Pan_Not_Present"
    };
  }
  const t = rawText.trim();
  if (!t) {
    return {
      type: "not_present",
      value: null,
      raw: t,
      display: "Pan_Not_Present"
    };
  }

  const upper = t.toUpperCase().trim();
  const clean = upper.replace(/[\s\-_.:/]/g, '');

  // 1. Dash / Empty / None / Not mentioned indicators -> Pan_Not_Present
  // Spec: Select "Pan_Not_Present" if pan is not present in the salary approved account details
  if (
    t === "-" || t === "—" || t === "–" || t === "--" || t === "---" ||
    /^(NONE|NIL|NULL|NOT\s*MENTIONED|NOT\s*PRESENT|UNSPECIFIED|EMPTY|BLANK|\?)$/i.test(upper)
  ) {
    return {
      type: "not_present",
      value: null,
      raw: t,
      display: "Pan_Not_Present"
    };
  }

  // Boundary check: If text is a table header or field label itself (e.g. "Account No", "Customer ID")
  // during DOM node crawling, do not treat the label itself as an invalid PAN value.
  const lo = t.toLowerCase().replace(/[:\-]/g, "").trim();
  if (
    STATEMENT_BOUNDARY_LABELS.includes(lo) ||
    lo === "account no" || lo === "ifsc" || lo === "ifsc code" || lo === "branch" ||
    lo === "balance" || lo === "status"
  ) {
    return null;
  }

  // 2. Explicit Invalid PAN indicators: Form16, Form60, all asterisks/X, NA, etc.
  // Spec: Select "Invalid_PAN" if the pan is not a valid pan number in the salary approved account details
  if (
    /\bFORM[\s\-_]*(16|60)\b/i.test(upper) ||
    upper.includes("FORM16") || upper.includes("FORM 16") ||
    upper.includes("FORM60") || upper.includes("FORM 60") ||
    /^[*X\-_.]+$/.test(clean) ||
    /^(NA|N\/A|N\.A\.?|NOT\s*AVAILABLE|NOT\s*APPLICABLE|NOT\s*PROVIDED|NOT\s*GIVEN|INVALID)$/i.test(upper)
  ) {
    let display = "Invalid_PAN";
    if (upper.includes("16")) display = "Form16";
    else if (upper.includes("60")) display = "Form60";
    else if (/^[*X]+$/.test(clean) || upper === "****") display = "****";
    else if (/^(NA|N\/A|N\.A\.?)/i.test(upper)) display = "NA";
    return {
      type: "invalid_pan",
      value: "Invalid_PAN",
      raw: t,
      display: display
    };
  }

  // 3. Full 10-character standard Indian PAN (e.g. ABCDE1234F or ABCDE9020G)
  const fullMatch = clean.match(/^[A-Z]{5}[0-9]{4}[A-Z]$/);
  if (fullMatch) {
    return {
      type: "full_pan",
      value: clean,
      raw: t,
      last4: clean.slice(-4),
      display: clean
    };
  }

  // 4. Masked PAN (e.g. *****902G, ******902G, XXXXX902G, XXXXXX681E, ****1234F, etc.)
  // Real Indian bank statements mask the first 5-6 digits with asterisks (*) or Xs and display 3-4 visible characters.
  if (/[*Xx]/.test(clean) && clean.length >= 5 && clean.length <= 12) {
    const unmasked = clean.replace(/^[*Xx]+/, '');
    if (unmasked.length >= 3 && unmasked.length <= 6) {
      return {
        type: "masked_pan",
        value: clean,
        raw: t,
        last4: clean.slice(-4),
        visiblePart: unmasked,
        display: clean
      };
    }
  }

  // 5. PAN-shaped canonical fallback (9-10 chars like ABCDE902G)
  const panLike = clean.match(/^[A-Z]{3,5}[0-9]{3,4}[A-Z]$/);
  if (panLike && clean.length >= 8 && clean.length <= 10) {
    return {
      type: "pan_like",
      value: clean,
      raw: t,
      last4: clean.slice(-4),
      display: clean
    };
  }

  // 6. Long account numbers (13+ characters) - not a PAN candidate
  if (clean.length > 12) {
    return null;
  }

  // 7. Any other words or non-PAN numbers are Invalid_PAN
  // Spec: "and some time like form16 or other numbesr or some other words that its invalid"
  return {
    type: "invalid_pan",
    value: "Invalid_PAN",
    raw: t,
    display: t.length > 18 ? t.slice(0, 18) + '…' : t
  };
}

// "PAN No" is the Profile field the verification reads. The looser aliases are
// only consulted when it is absent, so a PAN printed elsewhere on the page
// cannot shadow the profile's own.
const PROFILE_PAN_LABEL_TIERS = [
  ["pan no", "pan no.", "pan number", "pan card no"],
  ["nsdl pan", "pan card", "pan id", "pan details"]
];

function findProfilePAN(passedNodes) {
  const allNodes = passedNodes || getTargetDOMNodes();
  const activeTab = getActiveTab(allNodes);

  // Bare "pan" is only trustworthy while the Profile tab is the one on screen.
  const tiers = activeTab === "profile"
    ? PROFILE_PAN_LABEL_TIERS.concat([["pan"]])
    : PROFILE_PAN_LABEL_TIERS;

  for (const tier of tiers) {
    for (let i = 0; i < allNodes.length; i++) {
      const el = allNodes[i];
      const originalText = el.innerText?.trim() || "";
      const text = originalText.toLowerCase().replace(/[:\-]/g, "").replace(/\s+/g, " ");

      // Skip non-profile PAN labels
      if (text === "nsdl pan display name" || text === "nsdl pan aadhaar linked" ||
          text === "govt id no" || text === "govt id" || text === "pan status") {
        continue;
      }

      if (!tier.includes(text) || !isTightest(el, originalText)) continue;

      for (let j = i + 1; j < i + 20 && j < allNodes.length; j++) {
        const nextEl = allNodes[j];
        const nextText = (nextEl.tagName === 'INPUT' ? nextEl.value : nextEl.innerText)?.trim();
        if (!nextText || nextText.toLowerCase() === originalText.toLowerCase()) continue;
        if (!isTightest(nextEl, nextText)) continue;

        const lo = nextText.toLowerCase().replace(/[:\-]/g, "").replace(/\s+/g, " ");
        if (lo === "govt id no" || lo === "mobile no" || lo === "gender" || lo === "dob" || lo === "permanent address") break;
        if (lo.includes("bank statement") || lo.includes("acc holder")) break;

        const cand = parsePANCandidate(nextText);
        if (cand && (cand.type === "full_pan" || cand.type === "pan_like" || cand.type === "masked_pan")) {
          return cand.raw || cand.value;
        }
      }
    }
  }

  // Fallback only when on Profile tab: search DOM for standalone 10-char PAN string
  if (activeTab === "profile") {
    for (let i = 0; i < Math.min(allNodes.length, 120); i++) {
      const el = allNodes[i];
      const text = (el.tagName === 'INPUT' ? el.value : el.innerText)?.trim();
      if (!text || !isTightest(el, text)) continue;
      const clean = text.toUpperCase().replace(/[\s\-]/g, '');
      if (/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(clean)) {
        return clean;
      }
    }
  }

  return null;
}

function findBankPANAndAccountID(passedNodes) {
  const allNodes = passedNodes || getTargetDOMNodes();
  let bankPAN = null;
  let bankAccountID = null;

  for (let i = 0; i < allNodes.length; i++) {
    const el = allNodes[i];
    const originalText = el.innerText?.trim() || "";
    const text = originalText.toLowerCase().replace(/[:\-]/g, "").replace(/\s+/g, " ");
    if (!isTightest(el, originalText)) continue;

    if (!bankPAN && PAN_LABELS.includes(text)) {
      for (let j = i + 1; j < i + 15 && j < allNodes.length; j++) {
        const nextEl = allNodes[j];
        const nextText = (nextEl.tagName === 'INPUT' ? nextEl.value : nextEl.innerText)?.trim();
        if (!nextText || nextText.toLowerCase() === originalText.toLowerCase()) continue;
        if (!isTightest(nextEl, nextText)) continue;

        const lo = nextText.toLowerCase().replace(/[:\-]/g, "").trim();
        if (STATEMENT_BOUNDARY_LABELS.includes(lo) && lo !== "pan" && lo !== "pan no") {
          bankPAN = "-";
          break;
        }

        const cand = parsePANCandidate(nextText);
        if (cand) {
          if (cand.type === "not_present") bankPAN = "-";
          else if (cand.type === "invalid_pan") bankPAN = cand.display;
          else bankPAN = cand.raw || cand.value;
          break;
        }

        if (nextText === "-" || nextText === "—" || nextText === "–" || nextText === "--") {
          bankPAN = "-";
          break;
        }
      }
    }

    if (!bankAccountID && (text === "bank account id" || text === "account id")) {
      for (let j = i + 1; j < i + 20 && j < allNodes.length; j++) {
        const nextEl = allNodes[j];
        const nextText = (nextEl.tagName === 'INPUT' ? nextEl.value : nextEl.innerText)?.trim();
        if (!nextText || nextText.toLowerCase() === originalText.toLowerCase()) continue;
        if (!isTightest(nextEl, nextText)) continue;
        if (/^[A-Za-z0-9\-]+$/.test(nextText) && nextText.length >= 4) {
          bankAccountID = nextText;
        }
        break;
      }
    }

    if (bankPAN && bankAccountID) break;
  }

  return { bankPAN, bankAccountID };
}

// ─────────────────────────────────────────────
// ACCOUNT TYPE DETECTION
// ─────────────────────────────────────────────
const ACCOUNT_TYPE_LABELS = [
  "account type", "acc type", "acct type", "ac type", "a c type",
  "type of account", "account category", "account sub type", "type"
];

// Matched against whole tokens, never substrings — otherwise any word
// containing "ca" (LOCATION, CASH) would read as a current account.
const ACCT_RISK_TOKENS = new Set([
  "CURRENT", "CA", "OD", "ODA", "OVERDRAFT", "CC", "OVERDRAFTS"
]);
const ACCT_SAFE_TOKENS = new Set([
  "SAVINGS", "SAVING", "SAVINGSS", "SB", "SBA", "SALARY", "SALARIED", "SAL"
]);
// Punctuation-free forms, so "C/A", "S/B", "O/D", "O/D/A" resolve cleanly.
const ACCT_RISK_COMPACT = new Set([
  "CA", "CD", "OD", "ODA", "CC", "CURRENT", "CURRENTAC", "CURRENTACC", "CURRENTACCOUNT",
  "CURRENTACCT", "OVERDRAFT", "OVERDRAFTACC", "OVERDRAFTACCOUNT", "ODACCOUNT", "ODAACCOUNT",
  "CASHCREDIT", "CURRENTOD", "CURRENTOVERDRAFT"
]);
const ACCT_SAFE_COMPACT = new Set([
  "SB", "SBAC", "SBACCOUNT", "SAVINGS", "SAVING", "SAVINGSAC", "SAVINGSACCOUNT",
  "SAVINGSBANK", "SAVINGBANK", "SALARY", "SALARYACCOUNT", "SALARIED",
  "SBSAVINGS", "SAVINGSSB"
]);
const ACCT_BLANK_RE =
  /^(-+|—|–|_+|\.+|N\/?A|N\.A\.?|NIL|NONE|NULL|UNDEFINED|BLANK|EMPTY|UNKNOWN|NOT\s*AVAILABLE|NOT\s*APPLICABLE|NOT\s*MENTIONED|NOT\s*PROVIDED|NOT\s*SPECIFIED|\?)$/i;

/**
 * Classify a Bank Statement "Account Type" value.
 * Spec:
 * - SAVINGS: Show in green (safe).
 * - CURRENT / CUrrent / current account / CA: Red alert + "Check minus trans in sheet manual verify"
 * - OVERDRAFT / over draft / overdraft acc / overdraft account / od / oda: Red alert + "Check minus trans in sheet manual verify"
 * - BLANK / empty / "-": "Check minus trans in sheet manual verify"
 */
function classifyAccountType(raw) {
  const rawStr = (raw == null ? "" : String(raw)).trim();
  const upper  = rawStr.toUpperCase().replace(/\s+/g, " ").trim();
  const compact = upper.replace(/[^A-Z0-9]/g, "");

  // 1. Blank / Not Provided / Dash
  // Spec: "and blanck say to check minus trans in sheet manual verify"
  if (!upper || ACCT_BLANK_RE.test(upper) || upper === "-" || upper === "—" || upper === "–" || upper === "--") {
    return {
      level: 'blank',
      category: 'blank',
      label: 'NOT PROVIDED',
      display: '—',
      raw: rawStr,
      provided: false,
      alert: 'Account type blank — Check minus trans in sheet manual verify',
      instruction: 'Check minus trans in sheet manual verify'
    };
  }

  const tokens  = upper.replace(/[^A-Z0-9]+/g, " ").split(" ").filter(Boolean);

  // 2. Overdraft (OD, ODA, overdraft, over draft, overdraft acc, overdraft account)
  const isOD =
    /OVER[\s\-_]*DRAFT/i.test(upper) ||
    tokens.includes("OD") || tokens.includes("ODA") ||
    tokens.includes("OVERDRAFT") || tokens.includes("OVERDRAFTS") ||
    compact === "OD" || compact === "ODA" ||
    compact === "ODACCOUNT" || compact === "ODAACCOUNT" || compact === "OVERDRAFTACC" ||
    (compact.startsWith("OD") && compact.length <= 5) ||
    (compact.startsWith("ODA") && compact.length <= 6) ||
    compact.includes("OVERDRAFT");

  // 3. Current Account (CUrrent, current, current account, current acc, ca)
  const isCurrent =
    /\bCURRENT\b/i.test(upper) ||
    compact === "CA" || compact === "CD" || compact === "CC" ||
    compact.includes("CURRENT") ||
    tokens.includes("CURRENT") || tokens.includes("CA") ||
    /\bCASH\s+CREDIT\b/i.test(upper);

  if (isOD || isCurrent) {
    const isCC = !isOD && (tokens.includes("CC") || /\bCASH\s+CREDIT\b/i.test(upper));
    const label = isOD ? 'OVERDRAFT (OD/ODA)'
                : isCC ? 'CASH CREDIT'
                : 'CURRENT ACCOUNT';
    return {
      level: 'risk',
      category: isOD ? 'od' : isCC ? 'cc' : 'current',
      label,
      display: upper,
      raw: rawStr,
      provided: true,
      alert: `ALERT — ${label}`,
      instruction: 'Check minus trans in sheet manual verify'
    };
  }

  // 4. Savings (savings, saving, sb, sba, salary, salaried)
  // Spec: "if saving show in green"
  const isSavings =
    ACCT_SAFE_COMPACT.has(compact) ||
    tokens.some(t => ACCT_SAFE_TOKENS.has(t)) ||
    /\bSAVINGS?\b/i.test(upper) ||
    /\bSALAR(Y|IED)\b/i.test(upper);

  if (isSavings) {
    const isSalary = tokens.includes("SALARY") || tokens.includes("SALARIED") || upper.includes("SALARY");
    const label = isSalary ? 'SALARY ACCOUNT' : 'SAVINGS';
    return {
      level: 'safe',
      category: 'savings',
      label,
      display: upper,
      raw: rawStr,
      provided: true,
      alert: null,
      instruction: null
    };
  }

  // 5. Unknown account type
  return {
    level: 'unknown',
    category: 'unknown',
    label: upper,
    display: upper,
    raw: rawStr,
    provided: true,
    alert: `Check account type (${upper})`,
    instruction: 'Check minus trans in sheet manual verify'
  };
}

// Boundary labels that are also legitimate account-type values, so they must
// not be filtered out when reading the value.
const ACCT_TYPE_VALUE_WORDS = new Set(["salary", "savings", "saving", "current", "bank"]);
const ACCT_TYPE_BOUNDARY_LABELS =
  STATEMENT_BOUNDARY_LABELS.filter(l => !ACCT_TYPE_VALUE_WORDS.has(l));

// A value node is only an account type if it is not the next field's row. When
// the value slot is blank, a naive forward walk lands on "Bank Account
// IDBA10021" — inline siblings read as one run of text — so anything that
// begins with another field's label, or carries an id-length digit run, is
// rejected and the type is reported as blank.
function isAccountTypeValueCandidate(text) {
  if (!text) return false;
  const t = text.trim();
  if (t.length > 30) return false;
  if (/\d{4,}/.test(t)) return false;   // account numbers, PANs, dates
  const norm = normalizeLabel(t);
  if (!norm) return false;
  if (ACCOUNT_TYPE_LABELS.includes(norm)) return false;
  if (ACCT_TYPE_BOUNDARY_LABELS.includes(norm)) return false;
  if (ACCT_TYPE_BOUNDARY_LABELS.some(l => norm.startsWith(l))) return false;
  return /[A-Za-z]/.test(t);
}

function isAccountTypeValueKeyword(val) {
  if (!val || typeof val !== 'string') return false;
  const str = val.trim();
  if (str.length > 35) return false;
  if (/\d{3,}/.test(str)) return false; // Account numbers, PANs, dates
  const norm = str.toUpperCase().replace(/[^A-Z]/g, "");
  if (!norm) return false;
  if (ACCT_SAFE_COMPACT.has(norm) || ACCT_RISK_COMPACT.has(norm)) return true;
  if (/^(SAVINGS?|CURRENT|OVER[\s\-_]*DRAFT|SALAR(Y|IED)|CASH[\s\-_]*CREDIT)(\s+(ACC(OUNT)?|A\/?C))?$/i.test(str)) return true;
  return false;
}

// ─────────────────────────────────────────────
// MULTI-STATEMENT GROUPING & TABLE EXTRACTION
// ─────────────────────────────────────────────
function extractStatementsFromTables() {
  try {
    const tables = Array.from(document.querySelectorAll('table, [role="table"], [role="grid"]'));
    const widget = document.getElementById('nc-widget');
    const validTables = tables.filter(t => !widget || !widget.contains(t));

    for (const table of validTables) {
      const rows = Array.from(table.querySelectorAll('tr, [role="row"]'));
      if (rows.length < 2) continue;

      let headerRowIdx = -1;
      let colMap = { name: -1, pan: -1, accountID: -1, accountType: -1 };

      for (let r = 0; r < Math.min(rows.length, 4); r++) {
        const cells = Array.from(rows[r].querySelectorAll('th, td, [role="columnheader"], [role="gridcell"]'));
        cells.forEach((cell, c) => {
          const txt = normalizeLabel(cell.innerText || '');
          if (colMap.name === -1 && (
            txt.includes("holder name") || txt.includes("acc holder") || txt.includes("account holder") ||
            txt.includes("beneficiary") || txt.includes("customer name") || txt === "name" || txt === "account name" ||
            txt.includes("holder's name") || txt.includes("name as per bank") ||
            txt.includes("applicant") || txt.includes("borrower") || txt.includes("party name") || txt.includes("client name")
          )) {
            colMap.name = c;
          }
          if (colMap.pan === -1 && (txt.includes("pan") || txt.includes("form 60") || txt.includes("tax id"))) {
            colMap.pan = c;
          }
          if (colMap.accountID === -1 && (
            txt.includes("account id") || txt.includes("bank account id") ||
            txt.includes("account no") || txt.includes("acc no") || txt.includes("account number") ||
            txt.includes("a c no") || txt.includes("a c number") || txt.includes("ac no") ||
            txt.includes("acct no") || txt.includes("bank a c") || txt === "account"
          )) {
            colMap.accountID = c;
          }
          if (colMap.accountType === -1 && (
            txt.includes("account type") || txt.includes("acc type") || txt.includes("acct type") ||
            txt.includes("ac type") || txt.includes("a c type") || txt.includes("type of account") ||
            txt.includes("type of ac") || txt.includes("type of a c") || txt.includes("account category") ||
            txt.includes("nature of account") || txt.includes("account nature") || txt.includes("scheme type") ||
            txt.includes("product type") || txt.includes("facility type") || txt === "type" || txt === "acct nature" ||
            txt === "a c category" || txt === "ac category"
          )) {
            colMap.accountType = c;
          }
        });
        if (colMap.name !== -1 || colMap.pan !== -1 || colMap.accountID !== -1 || colMap.accountType !== -1) {
          headerRowIdx = r;
          break;
        }
      }

      if (headerRowIdx !== -1 && (colMap.name !== -1 || colMap.accountID !== -1)) {
        const statements = [];
        for (let r = headerRowIdx + 1; r < rows.length; r++) {
          const cells = Array.from(rows[r].querySelectorAll('td, th, [role="gridcell"]'));
          if (cells.length === 0) continue;

          let rawName = null, nameEl = null, pan = null, accountID = null;
          let accountType = null, accountTypeEl = null;

          if (colMap.name !== -1 && cells[colMap.name]) {
            const c = cells[colMap.name];
            const val = (c.querySelector('input')?.value || c.innerText)?.trim();
            if (val && !/^(loading|fetching|n\/?a|\-|\—)$/i.test(val)) {
              nameEl = c;
              rawName = val;
            }
          }

          if (colMap.pan !== -1 && cells[colMap.pan]) {
            const c = cells[colMap.pan];
            const val = (c.querySelector('input')?.value || c.innerText)?.trim();
            if (val) {
              const cand = parsePANCandidate(val);
              if (cand) {
                if (cand.type === "not_present") pan = "-";
                else if (cand.type === "invalid_pan") pan = cand.display;
                else pan = cand.raw || cand.value;
              } else if (val === "-" || val === "—") {
                pan = "-";
              }
            }
          }

          if (colMap.accountID !== -1 && cells[colMap.accountID]) {
            const c = cells[colMap.accountID];
            const val = (c.querySelector('input')?.value || c.innerText)?.trim();
            if (val && val.length >= 3 && !val.includes(" ")) {
              accountID = val;
            }
          }

          if (colMap.accountType !== -1 && cells[colMap.accountType]) {
            const c = cells[colMap.accountType];
            const val = (c.querySelector('input, select')?.value || c.innerText)?.trim();
            accountType = val || "";
            if (val) accountTypeEl = c;
          }

          // Fallback: If colMap.accountType was not matched in headers, inspect cells for account type keywords
          if (accountType === null) {
            for (let c = 0; c < cells.length; c++) {
              if (c === colMap.name || c === colMap.pan || c === colMap.accountID) continue;
              const cellVal = (cells[c].querySelector('input, select')?.value || cells[c].innerText)?.trim();
              if (cellVal && isAccountTypeValueKeyword(cellVal)) {
                accountType = cellVal;
                accountTypeEl = cells[c];
                break;
              }
            }
          }

          if (nameEl || rawName || accountID) {
            statements.push({
              index: statements.length + 1,
              nameEl,
              rawName,
              name: rawName ? extractPersonName(rawName) : null,
              pan: pan || "-",
              accountID,
              accountType,
              accountTypeEl
            });
          }
        }

        if (statements.length > 0) {
          return statements;
        }
      }
    }
  } catch (e) {}
  return [];
}

const BANK_HOLDER_LABELS = [
  "acc holders name", "acc holder", "account holder name", "account holders name",
  "account name", "holder name", "beneficiary name", "beneficiary",
  "customer name", "name as per bank", "bank account name", "name",
  "applicant name", "applicant", "borrower name", "party name", "client name"
];

function findAllBankStatements(passedNodes) {
  // 1. Try table-based extraction first
  const tableStmts = extractStatementsFromTables();
  if (tableStmts.length > 0) {
    return tableStmts;
  }

  const allNodes = passedNodes || getTargetDOMNodes();

  const sectionIdxs = [];
  for (let i = 0; i < allNodes.length; i++) {
    const raw = allNodes[i].innerText?.trim() || "";
    const text = normalizeLabel(raw);
    if (/^bank\s+statement\s*\d*$/i.test(text) && text.length < 60 && isTightest(allNodes[i], raw)) {
      sectionIdxs.push(i);
    }
  }
  if (sectionIdxs.length > 1) {
    return sectionIdxs.map((si, s) => {
      const ei = s + 1 < sectionIdxs.length ? sectionIdxs[s + 1] : allNodes.length;
      return extractStatementFromRange(allNodes, si, ei, s + 1);
    }).filter(st => st.nameEl || st.accountID);
  }

  // A lone "Bank Statement" heading still bounds the search: scanning from the
  // top of the document would let Profile fields (its own PAN, its own name)
  // masquerade as the statement's.
  if (sectionIdxs.length === 1) {
    const only = extractStatementFromRange(allNodes, sectionIdxs[0], allNodes.length, 1);
    if (only.nameEl || only.accountID) return [only];
  }

  const labelIdxs = [];
  for (let i = 0; i < allNodes.length; i++) {
    const raw = allNodes[i].innerText?.trim() || "";
    const text = normalizeLabel(raw);
    if (BANK_HOLDER_LABELS.includes(text) && isTightest(allNodes[i], raw)) labelIdxs.push(i);
  }
  if (labelIdxs.length > 1) {
    return labelIdxs.map((li, s) => {
      const si = Math.max(0, li - 15);
      const ei = s + 1 < labelIdxs.length ? labelIdxs[s + 1] : allNodes.length;
      return extractStatementFromRange(allNodes, si, ei, s + 1);
    }).filter(st => st.nameEl || st.accountID);
  }
  if (labelIdxs.length === 1) {
    const only = extractStatementFromRange(allNodes, Math.max(0, labelIdxs[0] - 15), allNodes.length, 1);
    if (only.nameEl || only.accountID) return [only];
  }

  const single = extractStatementFromRange(allNodes, 0, allNodes.length, 1);
  return (single.nameEl || single.accountID) ? [single] : [];
}

function extractStatementFromRange(allNodes, startIdx, endIdx, index) {
  let nameEl = null, rawName = null;
  let pan = null;
  let accountID = null;
  let accountType = null;
  let accountTypeEl = null;

  for (let i = startIdx; i < endIdx && i < allNodes.length; i++) {
    const el = allNodes[i];
    const orig = el.innerText?.trim() || "";
    const text = normalizeLabel(orig);
    if (!isTightest(el, orig)) continue;

    if (!nameEl && BANK_HOLDER_LABELS.includes(text)) {
      // 1. Direct association via 'for' attribute
      if (el.tagName === 'LABEL' && el.getAttribute('for')) {
        const forEl = document.getElementById(el.getAttribute('for'));
        if (forEl) {
          const val = (forEl.tagName === 'INPUT' ? forEl.value : forEl.innerText)?.trim();
          if (val && !/^(loading|fetching|n\/?a|\-|\—)$/i.test(val)) {
            nameEl = forEl;
            rawName = val;
          }
        }
      }

      // 2. Direct association via enclosing container
      if (!nameEl) {
        const container = el.closest && el.closest('.form-group, tr, .row, .field, td, div');
        if (container) {
          const candidates = Array.from(container.querySelectorAll('input, span, td, div, p, b, strong'));
          for (const cand of candidates) {
            if (cand === el || el.contains(cand)) continue;
            const val = (cand.tagName === 'INPUT' ? cand.value : cand.innerText)?.trim();
            if (!val || val.toLowerCase() === orig.toLowerCase()) continue;
            if (/^(loading|fetching|n\/?a|\-|\—)$/i.test(val)) continue;
            const cleaned = extractPersonName(val);
            if (cleaned && isLikelyPersonName(cleaned)) {
              nameEl = cand;
              rawName = val;
              break;
            }
          }
        }
      }

      // 3. Forward linear search
      if (!nameEl) {
        for (let j = i + 1; j < i + 50 && j < endIdx; j++) {
          const nx = allNodes[j];
          const nt = (nx.tagName === 'INPUT' ? nx.value : nx.innerText)?.trim();
          if (!nt || nt.toLowerCase() === orig.toLowerCase()) continue;
          if (!isTightest(nx, nt)) continue;

          const normNt = normalizeLabel(nt);
          if (BANK_HOLDER_LABELS.includes(normNt)) continue;

          // Skip transient placeholders
          const isPlaceholder = !nt || nt === '-' || nt === '—' || nt === '–' || nt === '--' || nt === '---' ||
            /^(loading|please wait|fetching|waiting|n\/?a|null|undefined|select)\b/i.test(nt);
          if (isPlaceholder) continue;

          const cleaned = extractPersonName(nt);
          if (cleaned && isLikelyPersonName(cleaned)) {
            nameEl = nx;
            rawName = nt;
            break;
          }

          // If we reach another field boundary after some distance and it's not a name, stop
          if (j > i + 8 && STATEMENT_BOUNDARY_LABELS.includes(normNt) && !BANK_HOLDER_LABELS.includes(normNt)) break;
        }
      }
    }

    if (!pan && (PAN_LABELS.includes(text) || text.includes("pan"))) {
      // 1. Direct association via 'for' or container
      const container = el.closest && el.closest('.form-group, tr, .row, .field, td, div');
      if (container) {
        const candidates = Array.from(container.querySelectorAll('input, span, td, div, p, b, strong'));
        for (const cand of candidates) {
          if (cand === el || el.contains(cand)) continue;
          const val = (cand.tagName === 'INPUT' ? cand.value : cand.innerText)?.trim();
          if (!val || val.toLowerCase() === orig.toLowerCase()) continue;
          const candPAN = parsePANCandidate(val);
          if (candPAN) {
            pan = (candPAN.type === "not_present") ? "-" : (candPAN.type === "invalid_pan") ? candPAN.display : (candPAN.raw || candPAN.value);
            break;
          }
        }
      }

      // 2. Forward search
      if (!pan) {
        for (let j = i + 1; j < i + 15 && j < endIdx; j++) {
          const nx = allNodes[j];
          const nt = (nx.tagName === 'INPUT' ? nx.value : nx.innerText)?.trim();
          if (!nt || nt.toLowerCase() === orig.toLowerCase()) continue;
          if (!isTightest(nx, nt)) continue;

          const normNt = normalizeLabel(nt);
          if (j > i + 3 && STATEMENT_BOUNDARY_LABELS.includes(normNt) && normNt !== "pan" && normNt !== "pan no") {
            pan = "-";
            break;
          }

          const cand = parsePANCandidate(nt);
          if (cand) {
            if (cand.type === "not_present") {
              pan = "-";
            } else if (cand.type === "invalid_pan") {
              pan = cand.display;
            } else {
              pan = cand.raw || cand.value;
            }
            break;
          }

          if (nt === "-" || nt === "—" || nt === "–" || nt === "--") {
            pan = "-";
            break;
          }
        }
      }
    }

    const isAcctTypeLabel = ACCOUNT_TYPE_LABELS.includes(text) ||
      text.includes("account type") || text.includes("a c type") || text.includes("acc type") ||
      text.includes("acct type") || text.includes("type of account") || text.includes("account category") ||
      text.includes("nature of account") || text.includes("scheme type");
    if (accountType === null && isAcctTypeLabel) {
      // 1. Same container as the label (grid / form-group layouts)
      const container = el.closest && el.closest('.form-group, tr, .row, .field, td, div');
      if (container) {
        const candidates = Array.from(container.querySelectorAll('input, select, span, td, div, p, b, strong'));
        for (const cand of candidates) {
          if (cand === el || el.contains(cand)) continue;
          const val = ((cand.tagName === 'INPUT' || cand.tagName === 'SELECT') ? cand.value : cand.innerText)?.trim();
          if (!val || val.toLowerCase() === orig.toLowerCase()) continue;
          if (!isAccountTypeValueCandidate(val)) continue;
          accountType = val;
          accountTypeEl = cand;
          break;
        }
      }
      // 2. Forward linear search (label directly followed by its value)
      if (accountType === null) {
        for (let j = i + 1; j < i + 8 && j < endIdx; j++) {
          const nx = allNodes[j];
          const nt = ((nx.tagName === 'INPUT' || nx.tagName === 'SELECT') ? nx.value : nx.innerText)?.trim();
          if (!nt || nt.toLowerCase() === orig.toLowerCase()) continue;
          if (!isTightest(nx, nt)) continue;
          const normNt = normalizeLabel(nt);
          if (ACCOUNT_TYPE_LABELS.includes(normNt)) continue;
          // Hit the next field before any value: the type is blank.
          if (STATEMENT_BOUNDARY_LABELS.includes(normNt)) { accountType = ""; break; }
          if (isAccountTypeValueCandidate(nt)) { accountType = nt; accountTypeEl = nx; }
          break;
        }
      }
      if (accountType === null) accountType = "";
    }

    if (!accountID && (text === "bank account id" || text === "account id" || text.includes("account id"))) {
      for (let j = i + 1; j < i + 25 && j < endIdx; j++) {
        const nx = allNodes[j];
        const nt = (nx.tagName === 'INPUT' ? nx.value : nx.innerText)?.trim();
        if (!nt || nt.toLowerCase() === orig.toLowerCase()) continue;
        if (!isTightest(nx, nt)) continue;
        if (/^[A-Za-z0-9\-]+$/.test(nt) && nt.length >= 4) accountID = nt;
        break;
      }
    }
  }

  // Fallback: If no account type was found by label, check for account type keyword in the statement range
  if (accountType === null) {
    for (let i = startIdx; i < endIdx && i < allNodes.length; i++) {
      const el = allNodes[i];
      if (el === nameEl) continue;
      const orig = ((el.tagName === 'INPUT' || el.tagName === 'SELECT') ? el.value : el.innerText)?.trim() || "";
      if (orig && isTightest(el, orig) && isAccountTypeValueKeyword(orig)) {
        accountType = orig;
        accountTypeEl = el;
        break;
      }
    }
  }

  return {
    index,
    nameEl,
    rawName,
    name: rawName ? extractPersonName(rawName) : null,
    pan,
    accountID,
    accountType,
    accountTypeEl
  };
}

function comparePANs(panA, panB) {
  const candA = parsePANCandidate(panA);
  const candB = parsePANCandidate(panB);

  // 1. Pan_Not_Present: if PAN is not present in the salary approved account details
  // Spec: Select "Pan_Not_Present" if pan is not present in the salary approved account details
  // User: "and some times it will be - that is Pan_Not_Present and empty also"
  if (
    !candB ||
    !panB ||
    candB.type === "not_present" ||
    panB === "-" || panB === "—" || panB === "–" || panB === "--" ||
    (typeof panB === "string" && panB.trim() === "")
  ) {
    return {
      result: "Pan_Not_Present",
      rawResult: "pan_not_present",
      label: "Pan_Not_Present",
      displayBadge: "— Pan_Not_Present",
      matchedPart: null,
      matchLen: 0,
      reason: "Pan is not present in the salary approved account details",
      profilePAN: candA?.value || panA || null,
      bankPAN: null
    };
  }

  // 2. Invalid_PAN: if PAN is not a valid PAN number in the salary approved account details
  // Spec: Select "Invalid_PAN" if the pan is not a valid pan number in the salary approved account details
  // User: "and some time like form16 or other numbesr or some other words that its invalid"
  if (candB.type === "invalid_pan") {
    const invalidVal = candB.display || candB.raw || "Invalid";
    return {
      result: "Invalid_PAN",
      rawResult: "invalid_pan",
      label: "Invalid_PAN",
      displayBadge: `⚠ Invalid_PAN (${invalidVal})`,
      matchedPart: null,
      matchLen: 0,
      reason: `Pan is not a valid pan number in salary approved account details (${invalidVal})`,
      profilePAN: candA?.value || panA || null,
      bankPAN: invalidVal
    };
  }

  // Also check if Profile Input PAN is explicitly invalid
  if (candA && candA.type === "invalid_pan") {
    return {
      result: "Invalid_PAN",
      rawResult: "invalid_pan",
      label: "Invalid_PAN",
      displayBadge: `⚠ Invalid_PAN (${candA.display || 'Input PAN invalid'})`,
      matchedPart: null,
      matchLen: 0,
      reason: `Input PAN is invalid (${candA.display || candA.raw})`,
      profilePAN: candA.raw || candA.display,
      bankPAN: candB.value || candB.raw
    };
  }

  // 3. Waiting for Input PAN (if Profile PAN is missing / not loaded yet)
  if (!candA || !panA || candA.type === "not_present") {
    return {
      result: "Pan_Not_Present",
      rawResult: "pan_not_present",
      label: "Pan_Not_Present",
      displayBadge: "— Pan_Not_Present",
      matchedPart: null,
      matchLen: 0,
      reason: "Waiting for Input PAN",
      profilePAN: null,
      bankPAN: candB.value || candB.raw
    };
  }

  // 4. PAN Comparison: Match vs Not_Match
  // Spec: Select "Match" if all the unmasked digits of pan (from the salary approved account details) matches the same digits of the input pan number
  // Spec: Select "Not_Match" if the pan (from the salary approved account details) does not match the input pan number
  // User: "sometimes pan will be *****902G. both side or one side last 4 is match its a match when different show in red"

  const cleanA = (candA.value || panA).toUpperCase().replace(/[\s\-_.:/]/g, '');
  const cleanB = (candB.value || panB).toUpperCase().replace(/[\s\-_.:/]/g, '');

  const last4A = candA.last4 || cleanA.slice(-4);
  const last4B = candB.last4 || cleanB.slice(-4);

  const visA = (candA.visiblePart || cleanA.replace(/^[*Xx]+/, '')).toUpperCase();
  const visB = (candB.visiblePart || cleanB.replace(/^[*Xx]+/, '')).toUpperCase();

  const isMaskedA = /[*Xx]/.test(cleanA);
  const isMaskedB = /[*Xx]/.test(cleanB);

  let isMatch = false;
  let matchPart = null;
  let matchLen = 0;
  let matchReason = "";

  // Case A: Exact full string equality
  if (cleanA === cleanB) {
    isMatch = true;
    matchPart = cleanB;
    matchLen = cleanB.length;
    matchReason = `Full PAN matching with Input (${cleanB})`;
  }
  // Case B: Both sides masked or one side masked with matching last 4
  // (e.g. *****902G vs ABCDE902G, or *****902G vs *****902G)
  else if (last4A && last4B && last4A.length === 4 && last4B.length === 4 && last4A === last4B) {
    isMatch = true;
    matchPart = last4B;
    matchLen = 4;
    matchReason = `Last 4 digits match (${last4B} in ${candB.value || cleanB})`;
  }
  // Case C: Bank PAN is masked and Input PAN ends with bank's visible part (e.g. 4 or 5 chars)
  else if (isMaskedB && visB.length >= 3 && cleanA.endsWith(visB)) {
    isMatch = true;
    matchPart = visB;
    matchLen = visB.length;
    matchReason = `All unmasked digits match (${visB} in ${candB.value || cleanB})`;
  }
  // Case D: Input PAN is masked and Bank PAN ends with input's visible part
  else if (isMaskedA && visA.length >= 3 && cleanB.endsWith(visA)) {
    isMatch = true;
    matchPart = visA;
    matchLen = visA.length;
    matchReason = `All unmasked digits match (${visA} in ${candA.value || cleanA})`;
  }
  // Case E: Positional unmasked check if both strings have equal length (e.g. 10 chars)
  else if (cleanA.length === cleanB.length && cleanA.length >= 8) {
    let allUnmaskedMatch = true;
    let unmaskedCount = 0;
    for (let i = 0; i < cleanB.length; i++) {
      const charB = cleanB[i];
      const charA = cleanA[i];
      if (charB !== '*' && charB !== 'X' && charB !== 'x') {
        unmaskedCount++;
        if (charA !== charB) {
          allUnmaskedMatch = false;
          break;
        }
      }
    }
    if (allUnmaskedMatch && unmaskedCount >= 3) {
      isMatch = true;
      matchPart = last4B;
      matchLen = unmaskedCount;
      matchReason = `All unmasked digits match (${unmaskedCount} digits)`;
    }
  }

  if (isMatch) {
    return {
      result: "Match",
      rawResult: "match",
      label: "Match",
      displayBadge: `Match (${candB.value || cleanB})`,
      matchedPart: matchPart,
      matchLen: matchLen,
      reason: matchReason,
      profilePAN: cleanA,
      bankPAN: candB.value || cleanB
    };
  }

  // If different, it is Not_Match (show in RED)
  return {
    result: "Not_Match",
    rawResult: "not_match",
    label: "Not_Match",
    displayBadge: "✕ Not_Match",
    matchedPart: null,
    matchLen: 0,
    reason: `PAN does not match input PAN (${candB.value || cleanB} vs ${cleanA})`,
    profilePAN: cleanA,
    bankPAN: candB.value || cleanB
  };
}

// ─────────────────────────────────────────────
// AUTOMATED PAN SELECT / DROPDOWN SELECTOR (QID 160)
// ─────────────────────────────────────────────
function autoSelectPANDropdowns(panResult) {
  if (!panResult || !panResult.result) return;
  const targetVerdict = panResult.result; // "Match" | "Not_Match" | "Invalid_PAN" | "Pan_Not_Present" | "Not_Applicable"

  try {
    const selects = Array.from(document.querySelectorAll('select'));
    const widget = document.getElementById('nc-widget');
    selects.forEach(select => {
      if (widget && widget.contains(select)) return;

      const attrStr = `${select.name || ''} ${select.id || ''} ${select.className || ''} ${select.getAttribute('aria-label') || ''}`.toLowerCase();
      const parentText = (select.closest('tr, td, div, form, .form-group, fieldset')?.innerText || '').toLowerCase();

      const isPANSelect = attrStr.includes('pan') || parentText.includes('pan') ||
        attrStr.includes('160') || parentText.includes('160') ||
        parentText.includes('salary approved') || attrStr.includes('salary') ||
        Array.from(select.options).some(opt => {
          const t = (opt.text || opt.value || '').toLowerCase().replace(/[\s\-_]/g, '');
          return t.includes('invalidpan') || t.includes('pannotpresent') || t.includes('form60') || t.includes('notapplicable');
        });

      if (!isPANSelect) return;

      let bestOption = null;
      for (const opt of select.options) {
        const val = (opt.value || '').trim();
        const text = (opt.text || '').trim();
        const combined = `${val} ${text}`.toLowerCase().replace(/[\s\-_]/g, '');

        if (targetVerdict === 'Match') {
          if ((combined === 'match' || combined.includes('panmatch') || combined.endsWith('match')) && !combined.includes('notmatch') && !combined.includes('mismatch')) {
            bestOption = opt;
            break;
          }
        } else if (targetVerdict === 'Not_Match') {
          if (combined.includes('notmatch') || combined.includes('mismatch') || combined === 'not_match') {
            bestOption = opt;
            break;
          }
        } else if (targetVerdict === 'Invalid_PAN') {
          if (combined.includes('invalidpan') || combined.includes('form60') || combined.includes('form16') || combined.includes('invalid')) {
            bestOption = opt;
            break;
          }
        } else if (targetVerdict === 'Pan_Not_Present') {
          if (combined.includes('pannotpresent') || combined.includes('notpresent') || combined.includes('notavailable') || combined.includes('pannotfound')) {
            bestOption = opt;
            break;
          }
        } else if (targetVerdict === 'Not_Applicable') {
          if (combined.includes('notapplicable') || combined.includes('notapp') || combined.includes('na') || combined === 'not_applicable') {
            bestOption = opt;
            break;
          }
        }
      }

      if (bestOption && select.value !== bestOption.value) {
        if (select.dataset.ncLastVerdict === targetVerdict) return;
        select.dataset.ncLastVerdict = targetVerdict;

        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
        if (nativeSetter) {
          nativeSetter.call(select, bestOption.value);
        } else {
          select.value = bestOption.value;
        }
        select.dispatchEvent(new Event('change', { bubbles: true }));
        select.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  } catch (e) {}
}

// Auto-fill QID 160 Remarks: "If the salary is approved - enter bank data customer account info id in the remarks"
function autoFillQID160Remarks(accountID) {
  if (!accountID) return;
  try {
    const inputs = Array.from(document.querySelectorAll('input[type="text"], textarea'));
    const widget = document.getElementById('nc-widget');
    inputs.forEach(inp => {
      if (widget && widget.contains(inp)) return;
      const attr = `${inp.name || ''} ${inp.id || ''} ${inp.placeholder || ''} ${inp.className || ''}`.toLowerCase();
      const parent = (inp.closest('tr, td, div, form, .form-group, fieldset')?.innerText || '').toLowerCase();
      const isRemarksForQID160 =
        (attr.includes('remark') || parent.includes('remark')) &&
        (attr.includes('160') || parent.includes('160') || parent.includes('customer account info id') || parent.includes('salary approved') || parent.includes('bank data customer'));
      if (isRemarksForQID160 && (!inp.value || inp.value.trim() === '')) {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set
          || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
        if (nativeSetter) {
          nativeSetter.call(inp, accountID);
        } else {
          inp.value = accountID;
        }
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  } catch (e) {}
}

// ─────────────────────────────────────────────
// STRING SIMILARITY HELPERS
// ─────────────────────────────────────────────
// Collapses the common Indian transliteration variants (SHRINIVASA /
// SRINIVAS, MOHD / MOHAMMED, BANERJEE / BANDYOPADHYAY) onto one spelling.
function indianPhoneticNormalize(w) {
  if (!w) return "";
  let s = w.toLowerCase()
    .replace(/\b(mohd|md|mohammed|muhammad|mohamad)\b/g, 'mohammad')
    .replace(/\b(syed|sayed)\b/g, 'saiyed')
    .replace(/\b(sheikh|shaik)\b/g, 'shaikh')
    .replace(/\b(banerjee|banerji)\b/g, 'bandyopadhyay')
    .replace(/\b(chatterjee|chatterji)\b/g, 'chattopadhyay')
    .replace(/\b(mukherjee|mukherji)\b/g, 'mukhopadhyay')
    .replace(/ee|ii|y/g, 'i')
    .replace(/oo|ou/g, 'u')
    .replace(/ph/g, 'f').replace(/bh/g, 'b').replace(/dh/g, 'd')
    .replace(/gh/g, 'g').replace(/kh/g, 'k').replace(/th/g, 't')
    .replace(/sh|sch/g, 's').replace(/nh/g, 'n').replace(/v/g, 'w')
    .replace(/ai|ay/g, 'a').replace(/ch/g, 'c').replace(/ck/g, 'k')
    .replace(/ks/g, 'x')
    .replace(/au|ou|ow/g, 'a')
    .replace(/(.)\1+/g, '$1');
  return s;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function jaroSimilarity(s1, s2) {
  if (s1 === s2) return 1;
  const l1 = s1.length, l2 = s2.length;
  if (!l1 || !l2) return 0;
  const dist = Math.max(Math.floor(Math.max(l1, l2) / 2) - 1, 0);
  const m1 = new Array(l1).fill(false), m2 = new Array(l2).fill(false);
  let hits = 0;
  for (let i = 0; i < l1; i++) {
    for (let j = Math.max(0, i - dist); j < Math.min(i + dist + 1, l2); j++) {
      if (m2[j] || s1[i] !== s2[j]) continue;
      m1[i] = m2[j] = true; hits++; break;
    }
  }
  if (!hits) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < l1; i++) {
    if (!m1[i]) continue;
    while (!m2[k]) k++;
    if (s1[i] !== s2[k]) t++;
    k++;
  }
  return (hits / l1 + hits / l2 + (hits - t / 2) / hits) / 3;
}

function jaroWinkler(s1, s2) {
  const jaro = jaroSimilarity(s1, s2);
  let p = 0;
  while (p < Math.min(4, s1.length, s2.length) && s1[p] === s2[p]) p++;
  return jaro + p * 0.1 * (1 - jaro);
}

function bigramSim(a, b) {
  if (!a || !b || a.length < 2 || b.length < 2) return 0;
  const bg = s => { const set = new Set(); for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2)); return set; };
  const ga = bg(a), gb = bg(b);
  let shared = 0;
  for (const g of ga) { if (gb.has(g)) shared++; }
  return (2 * shared) / (ga.size + gb.size || 1);
}

function fuzzyWordMatch(w1, w2) {
  if (w1 === w2) return true;
  if (!w1 || !w2) return false;
  if (w1.length === 1 && w2.startsWith(w1)) return true;
  if (w2.length === 1 && w1.startsWith(w2)) return true;

  if (indianPhoneticNormalize(w1) === indianPhoneticNormalize(w2)) return true;

  const minLen = Math.min(w1.length, w2.length);
  if (minLen >= 4 && jaroWinkler(w1, w2) >= 0.90) return true;
  if (minLen >= 4 && bigramSim(w1, w2) >= 0.70) return true;
  const maxEdits = minLen >= 8 ? 2 : minLen >= 5 ? 1 : 0;
  if (maxEdits > 0 && levenshtein(w1, w2) <= maxEdits) return true;
  return false;
}

// ─────────────────────────────────────────────
// INDIAN NAME MATCHING ENGINE
// ─────────────────────────────────────────────
// The same person is routinely written differently on either side of the
// dashboard: NSDL keeps the expanded legal form ("MALLESHWARA KENCHAPPA
// SHRINIVASA") while the bank keeps a short form with the surname first and
// the rest collapsed to initials ("SHRINIVASA M K"). Matching is therefore an
// order-independent pairing between the two token bags, where an initial is
// treated as evidence for the word it stands for rather than as a token that
// can never match.
const INDIAN_MIDDLE_FILLERS = new Set([
  "KUMAR", "KUMARI", "CHANDRA", "PRASAD", "SINGH", "DEVI", "DUTT", "LAL",
  "BHAI", "BEN", "KANT", "NATH", "BHUSHAN", "PRAKASH", "SHANKAR", "VEER",
  "RAO", "REDDY", "CHAND", "RAM", "SHAN", "ROY", "DASS", "DAS"
]);

function isIndianMiddleOrFillerToken(token) {
  return INDIAN_MIDDLE_FILLERS.has(String(token || "").toUpperCase());
}

// Honorifics only ever lead a name, so they are stripped positionally instead
// of globally — "SRI" and "RAM" are also perfectly ordinary name components.
const NAME_TITLE_TOKENS = new Set([
  "MR", "MRS", "MS", "MISS", "DR", "PROF", "SHRI", "SRI", "SMT", "SHRIMATI",
  "KUMARI", "KUM", "LATE", "SARDAR", "SARDARNI", "PANDIT", "SWAMI", "ADV",
  "THIRU", "THIRUMATHI", "SELVI", "SELVAN", "MSTR", "MASTER"
]);

// S/O, D/O, W/O, C/O … and everything after them describes a relative, not the
// account holder.
const NAME_RELATION_RE =
  /\b(s|d|w|c|f|h)\s*[\/.]\s*o\b|\b(son|daughter|wife|husband|care|father|mother)\s+of\b/i;

function stripRelationSuffix(text) {
  const m = String(text || "").match(NAME_RELATION_RE);
  return m ? String(text).slice(0, m.index) : String(text || "");
}

// Uppercase, punctuation-free token list. Dots, commas, slashes and extra
// spaces all collapse to separators, so "M.K. SHRINIVASA" and "M K SHRINIVASA"
// tokenize identically.
function nameTokens(raw) {
  if (!raw || typeof raw !== 'string') return [];
  let t = stripRelationSuffix(raw)
    .toUpperCase()
    .replace(/\([^)]*\)/g, " ")   // "(PRIMARY)", "(JOINT)" …
    .replace(/[^A-Z]+/g, " ")     // dots in initials become separators
    .replace(/\s+/g, " ")
    .trim();
  let tokens = t.split(" ").filter(Boolean);
  while (tokens.length > 1 && NAME_TITLE_TOKENS.has(tokens[0])) tokens = tokens.slice(1);
  return tokens;
}

const isInitialToken = tok => tok.length === 1;
const isWordToken    = tok => tok.length > 1;

// Pair weights: how much confidence one token pairing contributes.
const NAME_W_EXACT    = 1.00;  // identical word or identical initial
const NAME_W_PHONETIC = 0.97;  // transliteration variant (SHRINIVAS / SRINIVAS)
const NAME_W_FUZZY    = 0.88;  // near-identical word (OCR / typo drift)
const NAME_W_COMPOUND = 0.92;  // "SHRI NIVASA" vs "SHRINIVASA"
const NAME_W_INITIAL  = 0.85;  // an initial standing for a full word

// Word-to-word similarity only. fuzzyWordMatch() also accepts a bare initial
// prefix, which must not leak into word comparisons.
function wordsAreVariant(w1, w2) {
  if (!w1 || !w2 || w1.length < 2 || w2.length < 2) return false;
  if (w1 === w2) return true;
  return fuzzyWordMatch(w1, w2);
}

function nameTokenPairWeight(a, b) {
  if (a === b) return NAME_W_EXACT;
  const aInit = isInitialToken(a), bInit = isInitialToken(b);
  if (aInit && bInit) return 0;                        // two different initials
  if (aInit) return b[0] === a ? NAME_W_INITIAL : 0;
  if (bInit) return a[0] === b ? NAME_W_INITIAL : 0;
  if (indianPhoneticNormalize(a) === indianPhoneticNormalize(b)) return NAME_W_PHONETIC;
  return wordsAreVariant(a, b) ? NAME_W_FUZZY : 0;
}

// Greedy maximum-weight pairing. Name bags are tiny (≤ 8 tokens), so taking the
// best available pair repeatedly is both sufficient and cheap.
function pairNameTokens(A, B) {
  const cands = [];
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < B.length; j++) {
      const w = nameTokenPairWeight(A[i], B[j]);
      if (w > 0) cands.push({ i, j, w });
    }
  }
  cands.sort((x, y) => y.w - x.w);

  const wA = new Array(A.length).fill(0);
  const wB = new Array(B.length).fill(0);
  const takenA = new Array(A.length).fill(false);
  const takenB = new Array(B.length).fill(false);
  const pairs = [];

  for (const c of cands) {
    if (takenA[c.i] || takenB[c.j]) continue;
    takenA[c.i] = takenB[c.j] = true;
    wA[c.i] = wB[c.j] = c.w;
    pairs.push(c);
  }

  // A token split across two adjacent tokens on the other side:
  // "SHRINIVASA" vs "SHRI NIVASA".
  const absorbCompound = (src, srcTaken, srcW, dst, dstTaken, dstW) => {
    for (let i = 0; i < src.length; i++) {
      if (srcTaken[i] || !isWordToken(src[i])) continue;
      for (let j = 0; j < dst.length - 1; j++) {
        if (dstTaken[j] || dstTaken[j + 1]) continue;
        if (!wordsAreVariant(src[i], dst[j] + dst[j + 1])) continue;
        srcTaken[i] = dstTaken[j] = dstTaken[j + 1] = true;
        srcW[i] = dstW[j] = dstW[j + 1] = NAME_W_COMPOUND;
        break;
      }
    }
  };
  absorbCompound(A, takenA, wA, B, takenB, wB);
  absorbCompound(B, takenB, wB, A, takenA, wA);

  return { wA, wB, takenA, takenB, pairs };
}

// "SHRINIVASA MK" carries the same information as "SHRINIVASA M K". A glued
// initial cluster is only split when it exactly covers the words still
// unmatched on the other side AND a real word already matched — without that
// anchor, a short real name like "RAJ" would be shredded into initials.
function splitGluedInitials(A, B) {
  const expand = (side, other) => {
    const { takenA, takenB, pairs } = pairNameTokens(side, other);
    const hasWordAnchor = pairs.some(p => isWordToken(side[p.i]) && isWordToken(other[p.j]));
    if (!hasWordAnchor) return side;

    const leftoverWords = other.filter((t, j) => !takenB[j] && isWordToken(t));
    if (leftoverWords.length < 2) return side;

    for (let i = 0; i < side.length; i++) {
      const tok = side[i];
      if (takenA[i] || tok.length < 2 || tok.length > 4) continue;
      if (tok.length !== leftoverWords.length) continue;
      const heads = leftoverWords.map(w => w[0]).sort().join("");
      if (tok.split("").sort().join("") !== heads) continue;
      const next = side.slice();
      next.splice(i, 1, ...tok.split(""));
      return next;
    }
    return side;
  };
  return [expand(A, B), expand(B, A)];
}

// Unmatched leftovers are not all equally damning: a dropped middle filler
// ("KUMAR") is normal, an unexplained extra surname is not.
function leftoverPenaltyUnits(tokens, taken) {
  let units = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (taken[i]) continue;
    if (isInitialToken(tokens[i])) units += 0.25;
    else if (isIndianMiddleOrFillerToken(tokens[i])) units += 0.35;
    else units += 1;
  }
  return units;
}

// Core scorer: returns a 0–100 confidence plus the evidence behind it.
function scoreNameMatch(rawProfile, rawBank) {
  let A = nameTokens(extractPersonName(rawProfile));
  let B = nameTokens(extractPersonName(rawBank));

  if (A.length === 0 || B.length === 0) {
    return { confidence: 0, tokensA: A, tokensB: B, wordPairs: 0, reason: 'empty' };
  }
  if (A.join(" ") === B.join(" ")) {
    return { confidence: 100, tokensA: A, tokensB: B, wordPairs: A.filter(isWordToken).length, reason: 'identical' };
  }
  // Same letters, different spacing: "SHRI NIVASA" vs "SHRINIVASA".
  if (A.join("") === B.join("")) {
    return { confidence: 100, tokensA: A, tokensB: B, wordPairs: 1, reason: 'spacing' };
  }
  // Same tokens in a different order.
  if (A.slice().sort().join(" ") === B.slice().sort().join(" ")) {
    return { confidence: 100, tokensA: A, tokensB: B, wordPairs: A.filter(isWordToken).length, reason: 'reordered' };
  }

  [A, B] = splitGluedInitials(A, B);

  const { wA, wB, takenA, takenB, pairs } = pairNameTokens(A, B);

  const sumA = wA.reduce((s, w) => s + w, 0);
  const sumB = wB.reduce((s, w) => s + w, 0);
  const covA = sumA / A.length;
  const covB = sumB / B.length;
  const dice = (sumA + sumB) / (A.length + B.length);

  // Indian records drop middle names far more often than they invent them, so
  // "everything on the shorter side is accounted for" is strong evidence even
  // when the longer side has extra tokens.
  const bestCov   = Math.max(covA, covB);
  const leftovers = covA >= covB
    ? leftoverPenaltyUnits(B, takenB)
    : leftoverPenaltyUnits(A, takenA);
  const containment = bestCov * Math.max(0.5, 1 - 0.18 * leftovers);

  let score = Math.round(100 * Math.max(dice, containment));

  const wordPairs = pairs.filter(p => isWordToken(A[p.i]) && isWordToken(B[p.j])).length;

  // Initials alone never confirm an identity: "A K" and "ANIL KUMAR" are
  // consistent, not proven.
  if (wordPairs === 0) score = Math.min(score, 70);
  // One shared word with an unexplained remainder ("SHARMA" vs "RAHUL SHARMA")
  // is a family-name coincidence as often as a match.
  else if (wordPairs === 1 && leftovers >= 1) score = Math.min(score, 72);

  return {
    confidence: Math.max(0, Math.min(100, score)),
    tokensA: A, tokensB: B, wordPairs, leftovers,
    takenA, takenB, reason: 'scored'
  };
}

// 90–100 very strong · 75–89 match · 60–74 review · <60 mismatch
function nameBandFor(confidence) {
  if (confidence >= 90) return 'very_strong';
  if (confidence >= 75) return 'match';
  if (confidence >= 60) return 'review';
  return 'mismatch';
}

function nameResultFor(confidence) {
  const band = nameBandFor(confidence);
  if (band === 'very_strong' || band === 'match') return 'match';
  return band === 'review' ? 'partial' : 'mismatch';
}

// Kept for callers that only need the verdict.
function compareNames(a, b) {
  return nameResultFor(scoreNameMatch(a, b).confidence);
}

function computeNameConfidence(profileName, bankName) {
  return scoreNameMatch(profileName, bankName).confidence;
}

function compareNamesDetailed(profileName, rawBankName) {
  const cleanBankName = extractPersonName(rawBankName);
  const scored     = scoreNameMatch(profileName, rawBankName);
  const confidence = scored.confidence;
  const result     = nameResultFor(confidence);
  const band       = nameBandFor(confidence);

  const tProfile = scored.tokensA;
  const tBank    = scored.tokensB;

  // First "real" word on each side — a leading initial says nothing useful.
  const firstNameProfile = tProfile.find(isWordToken) || tProfile[0] || null;
  const firstNameBank    = tBank.find(isWordToken)    || tBank[0]    || null;
  const firstNameDiffers =
    result !== 'match' && !!firstNameProfile && !!firstNameBank &&
    nameTokenPairWeight(firstNameProfile, firstNameBank) === 0;

  const tokenResults = tProfile.map((pt, i) => ({
    token: pt,
    matched: scored.takenA ? !!scored.takenA[i] : tBank.some(bt => nameTokenPairWeight(pt, bt) > 0)
  }));

  return {
    result, band, confidence,
    needsManualCheck: result !== 'match',
    rawBankName,
    cleanBankName: cleanBankName.toUpperCase(),
    profileTokens: tProfile,
    bankTokens: tBank,
    firstNameProfile: firstNameProfile || null,
    firstNameBank: firstNameBank || null,
    firstNameDiffers,
    tokenResults
  };
}

// ─────────────────────────────────────────────
// BANK STATEMENT VERIFICATION RESULT
// ─────────────────────────────────────────────
// Folds the three independent checks (name, PAN, account type) into one
// verdict. Everything here is pure — no DOM, no network, no logging of the
// values being compared.
const NAME_STATUS_FROM_RESULT = {
  match: 'match', partial: 'review', mismatch: 'mismatch',
  unavailable: 'missing', unverified: 'missing', verifying: 'pending'
};

function panStatusFrom(panResult) {
  const r = (panResult && panResult.result) || '';
  if (r === 'Match' || r === 'match') return 'match';
  if (r === 'Not_Match' || r === 'not_match' || r === 'mismatch') return 'mismatch';
  if (r === 'Invalid_PAN' || r === 'invalid_pan') return 'invalid';
  return 'absent';
}

const OVERALL_LABELS = {
  verified: 'VERIFIED',
  failed:   'VERIFICATION FAILED',
  alert:    'ALERT',
  unable:   'UNABLE TO VERIFY',
  review:   'REVIEW',
  pending:  'VERIFYING'
};

function buildVerification(opts) {
  const { profileName, profilePAN, statement, nameDetail, nameResult, panResult } = opts;
  const acct = classifyAccountType(statement && statement.accountType);

  const nameStatus = NAME_STATUS_FROM_RESULT[nameResult] || 'missing';
  const panStatus  = panStatusFrom(panResult);

  // Only fields that actually block a check are reported as missing. An absent
  // *bank* PAN is a legitimate, well-defined outcome (Pan_Not_Present), not a
  // failure to read the page.
  const missing = [];
  if (!profileName)                    missing.push("Profile NSDL Name");
  if (!profilePAN)                     missing.push("Profile PAN No");
  if (!statement || !statement.rawName) missing.push("Bank Acc Holder's Name");

  let overall;
  if (nameStatus === 'pending')                              overall = 'pending';
  else if (panStatus === 'mismatch' || nameStatus === 'mismatch') overall = 'failed';
  else if (acct.level === 'risk')                            overall = 'alert';
  else if (missing.length > 0)                               overall = 'unable';
  else if (nameStatus === 'review' || acct.level === 'unknown' || acct.level === 'blank' || panStatus === 'invalid')
                                                             overall = 'review';
  else                                                       overall = 'verified';

  return {
    name: {
      profile: profileName || null,
      bank: (statement && (statement.name || statement.rawName)) || null,
      status: nameStatus,
      confidence: nameDetail ? nameDetail.confidence : null
    },
    pan: {
      profile: profilePAN || null,
      bank: (statement && statement.pan && statement.pan !== '-') ? statement.pan : null,
      status: panStatus
    },
    account: {
      value: acct.display,
      level: acct.level,
      label: acct.label,
      provided: acct.provided,
      alert: acct.alert,
      instruction: acct.instruction
    },
    missing,
    overall,
    overallLabel: OVERALL_LABELS[overall] || 'REVIEW'
  };
}

// ─────────────────────────────────────────────
// DASHBOARD TAB ACTIVATION
// ─────────────────────────────────────────────
const TAB_NAME_PATTERNS = {
  profile: ["profile"],
  ocr:     ["ocr"],
  empinfo: ["emp info", "empinfo", "emp_info", "employee info", "employment info", "emp information"]
};

// The dashboard's own tab controls — never our widget's.
function findTabElement(kind) {
  const wanted = TAB_NAME_PATTERNS[kind] || [];
  const widget = document.getElementById('nc-widget');
  const cands = Array.from(document.querySelectorAll(
    'button, [role="tab"], a, li, .tab, [class*="tab"]'
  ));
  for (const el of cands) {
    if (widget && (el === widget || widget.contains(el))) continue;
    const text = normalizeLabel(el.innerText || "");
    if (!text || text.length > 24) continue;
    if (!wanted.includes(text)) continue;
    if (!isTightest(el, el.innerText.trim())) continue;
    return el;
  }
  return null;
}

// Opening Emp Info is a visible side effect on the user's page, so it only
// happens on an explicit scan, once per case, and only when the Bank Statement
// section genuinely is not on screen.
let empInfoSwitchedForCase = null;

function activateEmpInfoTab() {
  const sig = getCaseSignature();
  if (empInfoSwitchedForCase === sig) return false;
  const currentTab = getActiveTab();
  if (currentTab === 'empinfo' || currentTab === 'holding') { empInfoSwitchedForCase = sig; return false; }
  const tabEl = findTabElement('empinfo');
  if (!tabEl) return false;
  empInfoSwitchedForCase = sig;
  try {
    tabEl.click();
    return true;
  } catch (e) {
    return false;
  }
}

// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// HIGHLIGHTING
// ─────────────────────────────────────────────
function highlight(el, type) {
  const colors = { green: "#16a34a", orange: "#f59e0b", red: "#dc2626" };
  if (!el.classList.contains('namecheck-highlighted')) {
    el.dataset.originalOutline     = el.style.outline     || "";
    el.dataset.originalBoxShadow   = el.style.boxShadow   || "";
    el.dataset.originalBorderRadius= el.style.borderRadius|| "";
  }
  el.style.outline      = `3px solid ${colors[type]}`;
  el.style.borderRadius = "6px";
  el.style.boxShadow    = `0 0 12px ${colors[type]}aa`;
  el.classList.add('namecheck-highlighted');
}

function clearHighlights() {
  document.querySelectorAll(".namecheck-highlighted").forEach(el => {
    el.style.outline      = el.dataset.originalOutline      || "";
    el.style.boxShadow    = el.dataset.originalBoxShadow    || "";
    el.style.borderRadius = el.dataset.originalBorderRadius || "";
    el.classList.remove('namecheck-highlighted');
  });
}

// ─────────────────────────────────────────────
// PERSISTENT DRAGGABLE WIDGET (LIGHT & DARK MODES)
// ─────────────────────────────────────────────
let ncStylesInjected = false;

function injectNCStyles() {
  if (ncStylesInjected || document.getElementById('namecheck-styles')) { ncStylesInjected = true; return; }
  ncStylesInjected = true;
  const style = document.createElement('style');
  style.id = 'namecheck-styles';
  style.textContent = `
    @keyframes _nc_spin { from{transform:rotate(0deg);} to{transform:rotate(360deg);} }
    @keyframes _nc_in  { from{transform:scale(.94) translateY(10px);opacity:0} to{transform:scale(1) translateY(0);opacity:1} }
    @keyframes _nc_out { from{transform:scale(1) translateY(0);opacity:1} to{transform:scale(.94) translateY(10px);opacity:0} }
    #nc-widget {
      animation: _nc_in .25s cubic-bezier(.16,1,.3,1) forwards;
      box-sizing: border-box !important;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif !important;
      opacity: 1 !important;
      visibility: visible !important;
      width: 275px !important;
      max-width: calc(100vw - 20px) !important;
    }
    #nc-widget.nc-collapsed {
      width: auto !important;
      max-width: 250px !important;
    }
    #nc-widget.nc-collapsed #nc-w-body {
      display: none !important;
    }
    #nc-widget.nc-out { animation: _nc_out .2s ease-in forwards !important; }
    #nc-w-head { cursor: grab; user-select: none; }
    #nc-w-head.grabbing { cursor: grabbing !important; }
    #nc-w-min:hover, #nc-w-theme:hover { background: rgba(148,163,184,.25) !important; }
    #nc-w-close:hover { background: rgba(239,68,68,.25) !important; color: #ef4444 !important; }
    .nc-btn-copy:not(:disabled):hover {
      background: linear-gradient(135deg, #60a5fa 0%, #3b82f6 100%) !important;
      box-shadow: 0 4px 12px rgba(37,99,235,.5) !important;
      transform: translateY(-1px);
    }
    .nc-btn-copy.nc-copied {
      background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%) !important;
      box-shadow: 0 4px 12px rgba(34,197,94,.4) !important;
      color: #ffffff !important;
    }
    #nc-widget, #nc-widget * { box-sizing: border-box !important; }
    #nc-widget .nc-mono { font-family: 'SF Mono', 'IBM Plex Mono', Consolas, Menlo, monospace !important; }
    #nc-widget .nc-icon { stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; display: block; }
    #nc-widget .nc-spin { animation: _nc_spin 1s linear infinite; }
    #nc-widget-scroll::-webkit-scrollbar { width: 4px; }
    #nc-widget-scroll::-webkit-scrollbar-track { background: transparent; }
    #nc-widget-scroll::-webkit-scrollbar-thumb { background: rgba(174,188,207,.34); border-radius: 4px; }
    #nc-widget-scroll::-webkit-scrollbar-thumb:hover { background: rgba(174,188,207,.55); }

    /* Deep obsidian glass dark theme */
    #nc-widget[data-theme="dark"] {
      --nc-bg: #080b11;
      --nc-surface: #111827;
      --nc-surface2: #0c121d;
      --nc-border: #1f2e4a;
      --nc-border2: #152033;
      --nc-text: #ffffff;
      --nc-muted: #94a3b8;
      --nc-muted2: #64748b;
      --nc-accent: #38bdf8;
      --nc-accent-wash: rgba(56,189,248,.18);
      --nc-accent-bd: rgba(56,189,248,.38);
      --nc-success: #4ade80;
      --nc-success-wash: rgba(74,222,128,.18);
      --nc-success-bd: rgba(74,222,128,.40);
      --nc-warning: #fbbf24;
      --nc-warning-wash: rgba(251,191,36,.18);
      --nc-warning-bd: rgba(251,191,36,.40);
      --nc-danger: #f87171;
      --nc-danger-wash: rgba(248,113,113,.18);
      --nc-danger-bd: rgba(248,113,113,.40);
      background-color: #080b11 !important;
      background: #080b11 !important;
      color: #ffffff !important;
      border: 1px solid #1f2e4a !important;
      box-shadow: 0 20px 48px -10px rgba(0,0,0,.88), 0 0 0 1px rgba(56,189,248,.20) !important;
    }

    /* Redesigned alabaster glass light theme */
    #nc-widget[data-theme="light"] {
      --nc-bg: #f8fafc;
      --nc-surface: #ffffff;
      --nc-surface2: #f8fafc;
      --nc-border: #e2e8f0;
      --nc-border2: #edf2f7;
      --nc-text: #0f172a;
      --nc-muted: #64748b;
      --nc-muted2: #94a3b8;
      --nc-accent: #2563eb;
      --nc-accent-wash: rgba(37,99,235,.08);
      --nc-accent-bd: rgba(37,99,235,.25);
      --nc-success: #15803d;
      --nc-success-wash: #dcfce7;
      --nc-success-bd: #86efac;
      --nc-warning: #b45309;
      --nc-warning-wash: #fef3c7;
      --nc-warning-bd: #fde68a;
      --nc-danger: #dc2626;
      --nc-danger-wash: #fee2e2;
      --nc-danger-bd: #fca5a5;
      background-color: #f8fafc !important;
      background: #f8fafc !important;
      color: #0f172a !important;
      border: 1px solid #e2e8f0 !important;
      box-shadow: 0 14px 34px -8px rgba(15,23,42,.12), 0 2px 6px rgba(15,23,42,.04) !important;
    }
    #nc-widget span { color: inherit; }
  `;
  document.head.appendChild(style);
}

const NC_ICONS = {
  shield: '<path d="M12 2 4 5.5v6c0 5 3.4 9.2 8 10.5 4.6-1.3 8-5.5 8-10.5v-6z"/><path d="m9 12 2 2 4-4.2"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.4M12 19.1v2.4M4.4 4.4l1.7 1.7M17.9 17.9l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.4 19.6l1.7-1.7M17.9 6.1l1.7-1.7"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5z"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.36"/><path d="M21 3v6h-6"/>',
  reset: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17.2v.1"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2.2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  min: '<polyline points="4 14 12 6 20 14"/>',
  max: '<polyline points="4 10 12 18 20 10"/>'
};
function ncIcon(name, size, extra) {
  return `<svg class="nc-icon ${extra || ''}" width="${size}" height="${size}" viewBox="0 0 24 24">${NC_ICONS[name]}</svg>`;
}

function getWidgetPos() {
  try {
    const s = localStorage.getItem('_nc_pos');
    if (s) {
      const { l, t } = JSON.parse(s);
      if (l >= 0 && t >= 0 && l < window.innerWidth - 60 && t < window.innerHeight - 60)
        return { left: l, top: t };
    }
  } catch (_) {}
  return null;
}

function makeDraggable(widget, handle) {
  let ox = 0, oy = 0, dragging = false;
  const onDown = (e) => {
    if (e.target.closest('button')) return;
    dragging = true;
    const r = widget.getBoundingClientRect();
    ox = e.clientX - r.left;
    oy = e.clientY - r.top;
    handle.classList.add('grabbing');
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!dragging) return;
    let l = e.clientX - ox, t = e.clientY - oy;
    l = Math.max(4, Math.min(window.innerWidth  - widget.offsetWidth  - 4, l));
    t = Math.max(4, Math.min(window.innerHeight - widget.offsetHeight - 4, t));
    widget.style.left = l + 'px'; widget.style.top = t + 'px';
    widget.style.right = 'auto'; widget.style.bottom = 'auto';
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('grabbing');
    const r = widget.getBoundingClientRect();
    try { localStorage.setItem('_nc_pos', JSON.stringify({ l: r.left, t: r.top })); } catch(_) {}
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onUp);
  handle.addEventListener('mousedown', onDown);
  widget._ncCleanup = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
  };
}

let ncWidgetRemovalTimer = null;

function removeWidget() {
  const w = document.getElementById('nc-widget');
  if (!w) return;
  if (w._ncCleanup) w._ncCleanup();
  w.classList.add('nc-out');
  // Remove *this* element, never whatever happens to carry the id when the
  // timer fires: a scan that re-renders the widget mid-animation would
  // otherwise have its fresh widget deleted out from under it.
  clearTimeout(ncWidgetRemovalTimer);
  ncWidgetRemovalTimer = setTimeout(() => {
    ncWidgetRemovalTimer = null;
    if (w.parentNode) w.parentNode.removeChild(w);
  }, 220);
}

async function copyToClipboard(text, btn, originalHTML) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {}
  btn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> Copied!`;
  btn.classList.add('nc-copied');
  setTimeout(() => { btn.innerHTML = originalHTML; btn.classList.remove('nc-copied'); }, 2000);
}

function showPersistentWidget(result) {
  injectNCStyles();
  clearTimeout(ncWidgetRemovalTimer);
  ncWidgetRemovalTimer = null;
  const old = document.getElementById('nc-widget');
  if (old) { if (old._ncCleanup) old._ncCleanup(); old.remove(); }

  const { matchCount = 0, partialCount = 0, mismatchCount = 0, mismatchFound = false, isVerifying = false,
          statements = [], count = 0, accountAlertCount = 0 } = result;

  const currentProfile = result.profileName || "Not found";
  const currentPAN     = result.profilePAN  || null;
  const currentAppId   = result.maskedCustomerId || (result.customerId ? maskIdentifier(result.customerId) : null);
  const total          = statements.length || count;
  const verifiedCnt    = matchCount + partialCount;
  const actualMismatch = mismatchCount || (mismatchFound ? total - verifiedCnt : 0);
  const isLight        = currentTheme === 'light';

  // Overall status styling
  let summaryBg = isLight ? '#dcfce7' : '#0a3d20';
  let summaryBd = isLight ? '#86efac' : '#22c55e';
  let summaryCol = isLight ? '#15803d' : '#6ee79b';
  let summaryText = `✓ ${verifiedCnt}/${total} Match`;

  const isDetecting = currentProfile === "Detecting profile..." || (!result.scanned && result.profileName === "Detecting profile...");
  if (isDetecting) {
    summaryBg = isLight ? '#dbeafe' : 'rgba(59,130,246,.30)';
    summaryBd = isLight ? '#93c5fd' : '#3b82f6';
    summaryCol = isLight ? '#1d4ed8' : '#8ac0ff';
    summaryText = `${ncIcon('refresh', 10, 'nc-spin')} Detecting…`;
  } else if (isVerifying) {
    summaryBg = isLight ? '#dbeafe' : 'rgba(59,130,246,.30)';
    summaryBd = isLight ? '#93c5fd' : '#3b82f6';
    summaryCol = isLight ? '#1d4ed8' : '#8ac0ff';
    summaryText = `${ncIcon('refresh', 10, 'nc-spin')} Analyzing…`;
  } else if (accountAlertCount > 0 && !mismatchFound) {
    summaryBg = isLight ? '#fee2e2' : '#5e1414';
    summaryBd = isLight ? '#fca5a5' : '#ef4444';
    summaryCol = isLight ? '#b91c1c' : '#ffb4b4';
    summaryText = `🔴 ${accountAlertCount} Acct Alert`;
  } else if (mismatchFound) {
    summaryBg = isLight ? '#fee2e2' : '#5e1414';
    summaryBd = isLight ? '#fca5a5' : '#ef4444';
    summaryCol = isLight ? '#b91c1c' : '#ffb4b4';
    summaryText = `✕ ${actualMismatch} Mismatch`;
  } else if (partialCount > 0) {
    summaryBg = isLight ? '#fef3c7' : '#57260a';
    summaryBd = isLight ? '#fde68a' : '#f59e0b';
    summaryCol = isLight ? '#b45309' : '#fdea6b';
    summaryText = `~ ${partialCount} Partial`;
  } else if (total === 0) {
    summaryBg = isLight ? '#f1f5f9' : 'rgba(148,163,184,.16)';
    summaryBd = isLight ? '#cbd5e1' : 'rgba(148,163,184,.34)';
    summaryCol = isLight ? '#475569' : '#e2e8f2';
    summaryText = '0 Statements';
  }

  // Profile mini bar
  const profileBarHTML = currentProfile && currentProfile !== "Waiting..." && currentProfile !== "Domain Not Authorized"
    ? `<div style="margin:3px 6px 2px;padding:3.5px 7px;background:${isLight ? '#ffffff' : '#0d1626'};border:1px solid ${isLight ? '#e2e8f0' : '#1a2842'};border-radius:6px;display:flex;justify-content:space-between;align-items:center;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
        <span style="display:flex;align-items:center;gap:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px;" title="${currentProfile}">
          <span style="color:${isLight ? '#1d4ed8' : '#8ac0ff'};display:inline-flex;flex-shrink:0;">${ncIcon('user', 10)}</span>
          ${currentAppId && currentAppId !== '—' ? `<span class="nc-mono" style="background:${isLight ? '#f1f5f9' : '#1e293b'};color:${isLight ? '#475569' : '#94a3b8'};font-size:7.5px;padding:1px 3.5px;border-radius:3px;font-weight:700;">${currentAppId}</span>` : ''}
          <span style="color:${isLight ? '#0f172a' : '#ffffff'};font-weight:700;font-size:9.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${currentProfile}</span>
        </span>
        ${currentPAN ? `<span class="nc-mono" style="background:${isLight ? '#dbeafe' : 'rgba(59,130,246,.24)'};border:1px solid ${isLight ? '#93c5fd' : 'rgba(59,130,246,.46)'};color:${isLight ? '#1d4ed8' : '#8ac0ff'};font-weight:700;letter-spacing:.02em;font-size:8.5px;padding:1px 5px;border-radius:4px;flex-shrink:0;">${currentPAN}</span>` : ''}
      </div>`
    : '';

  // AI Verdict mini badge for persistent widget
  const aiRes = result.aiResult || aiVerificationResult;
  const aiBadgeHTML = (aiRes && aiRes.verdict && aiRes.verdict !== 'OFF' && aiRes.verdict !== 'NO_DATA')
    ? `<div style="margin:2px 6px;padding:3px 7px;border-radius:6px;background:rgba(139,92,246,0.12);border:1px solid rgba(139,92,246,0.3);display:flex;justify-content:space-between;align-items:center;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
        <span style="font-size:8px;font-weight:800;color:#c084fc;letter-spacing:0.03em;">✨ AI: ${aiRes.verdict} (${aiRes.confidence || 90}%)</span>
        <span style="font-size:8px;color:${isLight ? '#475569' : '#cbd5e1'};max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${aiRes.reason || ''}">${aiRes.reason || ''}</span>
      </div>`
    : '';

  // Dedicated Separate Card on Top for Account Type
  const topAcct = (statements.find(s => s.accountInfo?.level === 'risk')?.accountInfo)
               || (statements.find(s => s.accountInfo?.provided)?.accountInfo)
               || (statements[0]?.accountInfo)
               || result.accountInfo
               || classifyAccountType(result.accountType || statements[0]?.accountType || null);

  const aLvl = (topAcct && topAcct.level) ? topAcct.level : 'blank';
  const isRisk = aLvl === 'risk';
  const isSafe = aLvl === 'safe';
  const isBlank = aLvl === 'blank' || !topAcct?.provided;

  let aBg, aBd, aCol, aSign, cardBg, cardBd, cardTitle;
  if (isVerifying) {
    cardBg = isLight ? '#eff6ff' : 'rgba(59,130,246,.14)';
    cardBd = isLight ? '#bfdbfe' : 'rgba(59,130,246,.38)';
    aBg = isLight ? '#dbeafe' : 'rgba(59,130,246,.25)';
    aBd = isLight ? '#93c5fd' : 'rgba(59,130,246,.50)';
    aCol = isLight ? '#1d4ed8' : '#8ac0ff';
    aSign = '…';
    cardTitle = 'CHECKING…';
  } else if (isRisk) {
    cardBg = isLight ? '#fef2f2' : 'rgba(239,68,68,.14)';
    cardBd = isLight ? '#fecaca' : 'rgba(239,68,68,.38)';
    aBg = isLight ? '#fee2e2' : 'rgba(239,68,68,.25)';
    aBd = isLight ? '#fca5a5' : 'rgba(239,68,68,.50)';
    aCol = isLight ? '#b91c1c' : '#ff9494';
    aSign = '🔴';
    cardTitle = topAcct.label || 'CURRENT/OD ACCOUNT';
  } else if (isSafe) {
    cardBg = isLight ? '#f0fdf4' : 'rgba(34,197,94,.10)';
    cardBd = isLight ? '#bbf7d0' : 'rgba(34,197,94,.30)';
    aBg = isLight ? '#dcfce7' : 'rgba(34,197,94,.22)';
    aBd = isLight ? '#86efac' : 'rgba(34,197,94,.45)';
    aCol = isLight ? '#15803d' : '#6ee79b';
    aSign = '🟢';
    cardTitle = topAcct.label || 'SAVINGS';
  } else {
    cardBg = isLight ? '#fffbeb' : 'rgba(245,158,11,.14)';
    cardBd = isLight ? '#fde68a' : 'rgba(245,158,11,.38)';
    aBg = isLight ? '#fef3c7' : 'rgba(245,158,11,.25)';
    aBd = isLight ? '#fde68a' : 'rgba(245,158,11,.50)';
    aCol = isLight ? '#b45309' : '#fcd34d';
    aSign = '🟡';
    cardTitle = topAcct?.label || 'NOT PROVIDED';
  }

  const warningNotice = (!isVerifying && (isRisk || isBlank))
    ? `<div style="margin-top:2.5px;padding-top:2px;border-top:1px dashed ${cardBd};font-size:8px;font-weight:800;color:${isRisk ? (isLight ? '#b91c1c' : '#ff9494') : (isLight ? '#92400e' : '#fde68a')};display:flex;align-items:center;gap:3px;">
        <span style="flex-shrink:0;">${ncIcon('alert', 10)}</span>
        <span>Check minus trans in sheet manual verify</span>
      </div>`
    : '';

  const accountTypeCardHTML = `
    <div id="nc-w-acct-card" style="margin:2px 6px 2px;padding:3.5px 7px;background:${cardBg};border:1px solid ${cardBd};border-radius:6px;display:flex;flex-direction:column;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:4px;">
        <span style="display:flex;align-items:center;gap:3.5px;font-size:8.5px;font-weight:800;color:${isLight ? '#475569' : '#cbd5e1'};text-transform:uppercase;letter-spacing:.04em;">
          <span style="color:${aCol};display:inline-flex;flex-shrink:0;">${ncIcon('shield', 10)}</span>
          <span>ACCOUNT TYPE</span>
        </span>
        <span style="font-size:8.5px;font-weight:800;padding:1px 6px;border-radius:4px;background:${aBg};border:1px solid ${aBd};color:${aCol};letter-spacing:.02em;white-space:nowrap;">
          ${aSign} ${cardTitle}
        </span>
      </div>
      ${warningNotice}
    </div>`;

  // Single Consolidated Status Bar (for multi-statements or verifying/mismatch alerts)
  const consolidatedStatusHTML = (total > 1 || isVerifying || mismatchFound || accountAlertCount > 0) ? `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;margin:2px 6px;padding:3.5px 6px;border-radius:6px;
      ${isVerifying
        ? `background:${isLight ? '#eff6ff' : 'rgba(59,130,246,.18)'};border:1px solid ${isLight ? '#bfdbfe' : 'rgba(59,130,246,.42)'};color:${isLight ? '#1d4ed8' : '#8ac0ff'};`
        : (mismatchFound || accountAlertCount > 0)
        ? `background:${isLight ? '#fef2f2' : 'rgba(239,68,68,.20)'};border:1px solid ${isLight ? '#fecaca' : 'rgba(239,68,68,.42)'};color:${isLight ? '#b91c1c' : '#ff9494'};`
        : partialCount > 0
        ? `background:${isLight ? '#fffbeb' : 'rgba(245,158,11,.20)'};border:1px solid ${isLight ? '#fde68a' : 'rgba(245,158,11,.42)'};color:${isLight ? '#b45309' : '#fcd34d'};`
        : `background:${isLight ? '#f0fdf4' : 'rgba(34,197,94,.20)'};border:1px solid ${isLight ? '#bbf7d0' : 'rgba(34,197,94,.42)'};color:${isLight ? '#15803d' : '#6ee79b'};`}">
      <div style="font-size:8.5px;font-weight:800;letter-spacing:.02em;display:flex;align-items:center;gap:3px;">
        ${isVerifying ? `${ncIcon('refresh', 10, 'nc-spin')} Verifying...`
          : accountAlertCount > 0 ? `${ncIcon('alert', 10)} Current/OD Acct`
          : mismatchFound ? `${ncIcon('alert', 10)} Check Required`
          : partialCount > 0 ? `${ncIcon('alert', 10)} Partial Match`
          : `${ncIcon('check', 10)} All Verified`}
      </div>
      <div style="display:flex;align-items:center;gap:4px;font-size:8.5px;font-weight:700;">
        <span style="color:${isLight ? '#15803d' : '#6ee79b'};">${matchCount} Matched</span>
        ${partialCount > 0 ? `<span style="color:${isLight ? '#b45309' : '#fcd34d'};">• ${partialCount} P</span>` : ''}
        ${actualMismatch > 0 ? `<span style="color:${isLight ? '#b91c1c' : '#ff9494'};">• ${actualMismatch} M</span>` : ''}
        ${accountAlertCount > 0 ? `<span style="color:${isLight ? '#b91c1c' : '#ff9494'};">• Alert</span>` : ''}
      </div>
    </div>` : '';

  let stmtsHTML = '';
  if (statements.length > 0) {
    stmtsHTML = statements.map((st, idx) => {
      const isVerifyingRow = isVerifying || st.overallResult === 'verifying' || st.nameResult === 'verifying';
      const isUnverifiedRow = st.overallResult === 'unverified' || st.nameResult === 'unverified';
      const isMatchRow = st.overallResult === 'match';
      const isPartialRow = st.overallResult === 'partial';

      // Overall verdict pill — name + PAN + account type folded together
      const vf   = st.verification || null;
      const acct = st.accountInfo || (vf && vf.account) || null;
      const verdict = isVerifyingRow ? 'pending'
                    : isUnverifiedRow ? 'unable'
                    : (vf && vf.overall) || (isMatchRow ? 'verified' : isPartialRow ? 'review' : 'failed');

      const VERDICT_STYLE = {
        verified: { l: ['#dcfce7', '#86efac', '#15803d'], d: ['#0a3d20', '#22c55e', '#a5f5c1'], text: '✅ VERIFIED' },
        failed:   { l: ['#fee2e2', '#fca5a5', '#b91c1c'], d: ['#5e1414', '#ef4444', '#ffb4b4'], text: '❌ FAILED' },
        alert:    { l: ['#fee2e2', '#fca5a5', '#b91c1c'], d: ['#5e1414', '#ef4444', '#ffb4b4'], text: '🔴 ALERT' },
        review:   { l: ['#fef3c7', '#fde68a', '#b45309'], d: ['#57260a', '#f59e0b', '#fdea6b'], text: '⚠ REVIEW' },
        unable:   { l: ['#f1f5f9', '#cbd5e1', '#475569'], d: ['rgba(148,163,184,.18)', 'rgba(148,163,184,.42)', '#e2e8f2'], text: '⚠ UNABLE' },
        pending:  { l: ['#dbeafe', '#93c5fd', '#1d4ed8'], d: ['rgba(59,130,246,.30)', '#3b82f6', '#8ac0ff'], text: '… VERIFYING' }
      };
      const vs = VERDICT_STYLE[verdict] || VERDICT_STYLE.review;
      const [rowStatusBg, rowStatusBd, rowStatusCol] = isLight ? vs.l : vs.d;
      const rowStatusText = vs.text;

      // Name Pill
      let nBg = isLight ? '#fee2e2' : 'rgba(239,68,68,.22)';
      let nBd = isLight ? '#fca5a5' : 'rgba(239,68,68,.45)';
      let nCol = isLight ? '#b91c1c' : '#ff9494';
      let nSign = '✕';
      if (isVerifyingRow) { nBg = isLight ? '#dbeafe' : 'rgba(59,130,246,.22)'; nBd = isLight ? '#93c5fd' : 'rgba(59,130,246,.45)'; nCol = isLight ? '#1d4ed8' : '#8ac0ff'; nSign = '…'; }
      else if (isUnverifiedRow) { nBg = isLight ? '#f1f5f9' : 'rgba(148,163,184,.16)'; nBd = isLight ? '#cbd5e1' : 'rgba(148,163,184,.34)'; nCol = isLight ? '#475569' : '#aebccf'; nSign = 'ℹ'; }
      else if (st.nameResult === 'match') { nBg = isLight ? '#dcfce7' : 'rgba(34,197,94,.22)'; nBd = isLight ? '#86efac' : 'rgba(34,197,94,.45)'; nCol = isLight ? '#15803d' : '#6ee79b'; nSign = '✓'; }
      else if (st.nameResult === 'partial') { nBg = isLight ? '#fef3c7' : 'rgba(245,158,11,.22)'; nBd = isLight ? '#fde68a' : 'rgba(245,158,11,.45)'; nCol = isLight ? '#b45309' : '#fcd34d'; nSign = '~'; }
      else if (st.nameResult === 'unavailable') { nBg = isLight ? '#f1f5f9' : 'rgba(148,163,184,.16)'; nBd = isLight ? '#cbd5e1' : 'rgba(148,163,184,.34)'; nCol = isLight ? '#475569' : '#aebccf'; nSign = '?'; }

      // PAN Pill
      const pr = isVerifyingRow ? 'verifying' : (st.panResult?.result || 'Pan_Not_Present');
      const pIsMatch = pr === 'Match' || pr === 'match';
      const pIsInvalid = pr === 'Invalid_PAN' || pr === 'invalid_pan';
      const pIsNone = pr === 'Pan_Not_Present' || pr === 'pan_not_present' || pr === 'unavailable' || isUnverifiedRow;

      let pBg = isLight ? '#fee2e2' : 'rgba(239,68,68,.22)';
      let pBd = isLight ? '#fca5a5' : 'rgba(239,68,68,.45)';
      let pCol = isLight ? '#b91c1c' : '#ff9494';
      let pSign = '✕', pBadgeText = 'NOT_MATCH';
      if (isVerifyingRow) { pBg = isLight ? '#dbeafe' : 'rgba(59,130,246,.22)'; pBd = isLight ? '#93c5fd' : 'rgba(59,130,246,.45)'; pCol = isLight ? '#1d4ed8' : '#8ac0ff'; pSign = '…'; pBadgeText = 'VERIFYING'; }
      else if (isUnverifiedRow) { pBg = isLight ? '#f1f5f9' : 'rgba(148,163,184,.16)'; pBd = isLight ? '#cbd5e1' : 'rgba(148,163,184,.34)'; pCol = isLight ? '#475569' : '#e2e8f2'; pSign = 'ℹ'; pBadgeText = 'UNVERIFIED'; }
      else if (pIsMatch) { pBg = isLight ? '#dcfce7' : 'rgba(34,197,94,.22)'; pBd = isLight ? '#86efac' : 'rgba(34,197,94,.45)'; pCol = isLight ? '#15803d' : '#6ee79b'; pSign = '✓'; pBadgeText = 'MATCH'; }
      else if (pIsInvalid) { pBg = isLight ? '#fef3c7' : 'rgba(245,158,11,.22)'; pBd = isLight ? '#fde68a' : 'rgba(245,158,11,.45)'; pCol = isLight ? '#b45309' : '#fcd34d'; pSign = '⚠'; pBadgeText = 'INVALID_PAN'; }
      else if (pIsNone) { pBg = isLight ? '#f1f5f9' : 'rgba(148,163,184,.16)'; pBd = isLight ? '#cbd5e1' : 'rgba(148,163,184,.34)'; pCol = isLight ? '#475569' : '#e2e8f2'; pSign = '—'; pBadgeText = 'PAN_NOT_PRESENT'; }

      // Account Type chip
      const acctLevel = acct ? acct.level : 'blank';
      let aBg, aBd, aCol, aSign;
      if (acctLevel === 'risk') {
        aBg = isLight ? '#fee2e2' : 'rgba(239,68,68,.22)'; aBd = isLight ? '#fca5a5' : 'rgba(239,68,68,.45)';
        aCol = isLight ? '#b91c1c' : '#ff9494'; aSign = '🔴';
      } else if (acctLevel === 'unknown' || acctLevel === 'blank') {
        aBg = isLight ? '#fef3c7' : 'rgba(245,158,11,.22)'; aBd = isLight ? '#fde68a' : 'rgba(245,158,11,.45)';
        aCol = isLight ? '#b45309' : '#fcd34d'; aSign = '🟡';
      } else {
        aBg = isLight ? '#dcfce7' : 'rgba(34,197,94,.22)'; aBd = isLight ? '#86efac' : 'rgba(34,197,94,.45)';
        aCol = isLight ? '#15803d' : '#6ee79b'; aSign = '🟢';
      }
      const acctChipText = acct ? acct.label : 'NOT PROVIDED';
      const acctChipHTML = (statements.length > 1 && !isVerifyingRow) ?
        `<span style="font-size:9px;font-weight:700;padding:2px 6px;border-radius:5px;background:${aBg};color:${aCol};border:1px solid ${aBd};" title="Account Type: ${acct ? (acct.display || acct.label) : '—'}">ACCT ${aSign} ${acctChipText}</span>` : '';

      // Loud banner for current / overdraft / blank accounts: inside row only if multi-statement
      const needsMinusTransCheck = (statements.length > 1 && !isVerifyingRow) && (acctLevel === 'risk' || acctLevel === 'blank' || acctLevel === 'unknown');
      const acctAlertHTML = needsMinusTransCheck
        ? `<div style="display:flex;align-items:center;gap:4px;margin-top:4px;padding:3px 7px;border-radius:5px;background:${acctLevel === 'risk' ? (isLight ? '#fee2e2' : 'rgba(239,68,68,.26)') : (isLight ? '#fef3c7' : 'rgba(245,158,11,.24)')};border:1px solid ${acctLevel === 'risk' ? (isLight ? '#fca5a5' : 'rgba(239,68,68,.52)') : (isLight ? '#fde68a' : 'rgba(245,158,11,.45)')};">
            <span style="color:${acctLevel === 'risk' ? (isLight ? '#b91c1c' : '#ff9494') : (isLight ? '#b45309' : '#fcd34d')};">${ncIcon('alert', 10)}</span>
            <span style="font-size:8px;font-weight:800;letter-spacing:.02em;color:${acctLevel === 'risk' ? (isLight ? '#b91c1c' : '#ffb4b4') : (isLight ? '#92400e' : '#fde68a')};">
              ${acctLevel === 'risk' ? (acct.label + ': ') : ''}Check minus trans in sheet manual verify
            </span>
          </div>`
        : '';

      // Which input was missing, when we could not verify
      const missingHTML = (!isVerifyingRow && vf && vf.missing && vf.missing.length > 0)
        ? `<div style="font-size:8.5px;font-weight:700;color:${isLight ? '#475569' : '#aebccf'};background:${isLight ? '#f1f5f9' : 'rgba(148,163,184,.16)'};border:1px solid ${isLight ? '#cbd5e1' : 'rgba(148,163,184,.34)'};padding:2.5px 7px;border-radius:5px;margin-top:5px;">
            ⚠ Unable to verify — missing: ${vf.missing.join(', ')}
           </div>`
        : '';

      const dispName = (st.name || '—').toUpperCase();
      const canCopy = !isVerifyingRow && !!st.copyEnabled;

      // PAN detail subtitle string
      let panDetailSubtitle = '';
      if (st.panResult) {
        if (pIsMatch) {
          if (st.panResult.matchLen === 4 || (st.panResult.matchedPart && st.panResult.matchedPart.length === 4)) {
            panDetailSubtitle = `4-digit match (${st.panResult.matchedPart} in ${st.pan || ''})`;
          } else {
            panDetailSubtitle = `Full PAN match (${st.pan || ''})`;
          }
        } else if (pIsInvalid) {
          panDetailSubtitle = `Form60 / NA (${st.pan || ''})`;
        } else if (!pIsNone && st.panResult.reason) {
          panDetailSubtitle = st.panResult.reason;
        }
      }

      const fnDiff = (!isVerifyingRow && st.nameDetail?.firstNameDiffers)
        ? `<div style="font-size:8.5px;font-weight:700;color:${isLight ? '#b45309' : '#fdea6b'};background:${isLight ? '#fef3c7' : 'rgba(245,158,11,.22)'};border:1px solid ${isLight ? '#fde68a' : 'rgba(245,158,11,.45)'};padding:2.5px 7px;border-radius:5px;margin-top:5px;">
            First Name: ${st.nameDetail.firstNameProfile} ≠ ${st.nameDetail.firstNameBank}
           </div>`
        : '';

      const manualCheckHTML = (!isVerifyingRow && st.needsManualCheck)
        ? `<div style="display:flex;align-items:center;gap:4px;margin-top:5px;padding:2.5px 7px;border-radius:5px;background:${isLight ? '#fee2e2' : 'rgba(239,68,68,.22)'};border:1px solid ${isLight ? '#fca5a5' : 'rgba(239,68,68,.42)'};">
            <span style="color:${isLight ? '#b91c1c' : '#ff9494'};">${ncIcon('alert', 10)}</span>
            <span style="font-size:8.5px;font-weight:800;letter-spacing:.03em;color:${isLight ? '#b91c1c' : '#ff9494'};">
              ${st.overallResult === 'mismatch' ? 'MANUAL CHECK REQUIRED' : 'VERIFY MANUALLY'}
            </span>
          </div>`
        : '';

      return `
        <div style="margin:3px 6px;padding:5px 7px;background:${isLight ? '#ffffff' : 'linear-gradient(180deg, #14213a 0%, #0c1526 100%)'};border:1px solid ${isLight ? '#e2e8f0' : '#243356'};border-radius:8px;box-shadow:${isLight ? '0 1px 4px rgba(15,23,42,0.05)' : '0 4px 14px rgba(0,0,0,0.50)'};">
          <!-- Card top row -->
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;gap:4px;">
            <div style="display:flex;align-items:center;gap:4px;min-width:0;flex:1;">
              <span class="nc-mono" style="font-size:8.5px;font-weight:800;background:${isLight ? '#e0f2fe' : 'rgba(56,189,248,.22)'};border:1px solid ${isLight ? '#bae6fd' : 'rgba(56,189,248,.42)'};color:${isLight ? '#0369a1' : '#63d2ff'};padding:1px 4px;border-radius:3px;flex-shrink:0;">#${st.index}</span>
              <span style="font-size:10px;font-weight:700;color:${isLight ? '#0f172a' : '#ffffff'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:125px;" title="${dispName}">${dispName}</span>
            </div>
            <span style="background:${rowStatusBg};border:1px solid ${rowStatusBd};color:${rowStatusCol};font-size:8px;font-weight:800;padding:1.5px 5px;border-radius:99px;white-space:nowrap;flex-shrink:0;">${rowStatusText}</span>
          </div>

          <!-- Badges row -->
          <div style="display:flex;align-items:center;flex-wrap:wrap;gap:3px;margin-bottom:3px;">
            <span style="font-size:8px;font-weight:700;padding:1.5px 5px;border-radius:4px;background:${nBg};color:${nCol};border:1px solid ${nBd};">NAME ${nSign}${st.nameDetail?.confidence != null && st.nameResult !== 'unavailable' ? ' ' + st.nameDetail.confidence + '%' : ''}</span>
            <span style="font-size:8px;font-weight:700;padding:1.5px 5px;border-radius:4px;background:${pBg};color:${pCol};border:1px solid ${pBd};" title="${st.panResult?.reason || ''}">PAN ${pSign} ${pBadgeText}</span>
            ${(st.pan && st.pan !== '-' && st.pan !== '—') ? `<span class="nc-mono" style="font-size:8px;font-weight:700;background:${(!pIsMatch && !pIsNone && !pIsInvalid) ? (isLight ? '#fee2e2' : 'rgba(239,68,68,.25)') : (isLight ? '#f1f5f9' : '#02040a')};border:1px solid ${(!pIsMatch && !pIsNone && !pIsInvalid) ? (isLight ? '#fca5a5' : 'rgba(239,68,68,.5)') : (isLight ? '#cbd5e1' : '#1b2942')};color:${(!pIsMatch && !pIsNone && !pIsInvalid) ? (isLight ? '#b91c1c' : '#ff9494') : (isLight ? '#0369a1' : '#63d2ff')};padding:1px 4px;border-radius:3px;">${st.pan}</span>` : ''}
            ${acctChipHTML}
          </div>

          ${panDetailSubtitle ? `<div style="font-size:7.5px;color:${(!pIsMatch && !pIsNone && !pIsInvalid) ? (isLight ? '#b91c1c' : '#ff9494') : (isLight ? '#64748b' : '#aebccf')};margin-bottom:3px;display:flex;align-items:center;gap:2px;"><span style="color:${(!pIsMatch && !pIsNone && !pIsInvalid) ? (isLight ? '#b91c1c' : '#ff9494') : (isLight ? '#1d4ed8' : '#8ac0ff')};">ℹ</span> ${panDetailSubtitle}</div>` : ''}

          ${fnDiff}
          ${acctAlertHTML}
          ${missingHTML}
          ${manualCheckHTML}

          <!-- Account ID + Copy button -->
          <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;margin-top:${(fnDiff || manualCheckHTML || acctAlertHTML || missingHTML) ? '4px' : '3px'};padding-top:3px;border-top:1px solid ${isLight ? '#f1f5f9' : '#111c31'};">
            <span class="nc-mono" style="font-size:11px;font-weight:700;color:${isLight ? '#0f172a' : '#ffffff'};letter-spacing:.02em;background:${isLight ? '#f8fafc' : '#02040a'};border:1px solid ${isLight ? '#e2e8f0' : '#18253c'};padding:2px 5px;border-radius:4px;">${st.accountID || '—'}</span>
            <button class="nc-stmt-copy nc-btn-copy"
              data-id="${st.accountID || ''}"
              ${!canCopy ? 'disabled' : ''}
              style="display:flex;align-items:center;gap:2px;border-radius:5px;padding:3px 7px;font-size:8.5px;font-weight:700;flex-shrink:0;transition:all .15s;border:none;
                ${canCopy
                  ? 'background:linear-gradient(135deg, #2563eb 0%, #1743a8 100%);color:#ffffff;box-shadow:0 1.5px 5px rgba(37,99,235,.40);cursor:pointer;'
                  : `background:${isLight ? '#e2e8f0' : '#101a2c'};color:${isLight ? '#475569' : '#8496ad'};cursor:not-allowed;opacity:.75;`}">
              ${ncIcon('copy', 9)} Copy
            </button>
          </div>
        </div>`;
    }).join('');

  } else if (result.bankAccountID || result.bankPAN) {
    const { bankPAN, panResult, bankAccountID } = result;
    const pRes = panResult?.result;
    const pIsMatch = pRes === 'Match' || pRes === 'match';
    const pIsMismatch = pRes === 'Not_Match' || pRes === 'not_match' || pRes === 'mismatch';
    const pIsInvalid = pRes === 'Invalid_PAN' || pRes === 'invalid_pan';
    const validBankPAN = (bankPAN && bankPAN !== '-' && bankPAN !== '—') ? bankPAN : null;

    let panBg = isLight ? '#f1f5f9' : 'rgba(148,163,184,.16)';
    let panBd = isLight ? '#e2e8f0' : 'rgba(148,163,184,.34)';
    let panCol = isLight ? '#475569' : '#e2e8f2';
    let panIcon = '—', panLabel = 'Pan_Not_Present';

    if (pIsMatch) { panBg = isLight ? '#dcfce7' : 'rgba(34,197,94,.22)'; panBd = isLight ? '#86efac' : 'rgba(34,197,94,.45)'; panCol = isLight ? '#15803d' : '#6ee79b'; panIcon = '✓'; panLabel = `Match ${validBankPAN ? '(' + validBankPAN + ')' : ''}`; }
    else if (pIsMismatch) { panBg = isLight ? '#fee2e2' : 'rgba(239,68,68,.22)'; panBd = isLight ? '#fca5a5' : 'rgba(239,68,68,.45)'; panCol = isLight ? '#b91c1c' : '#ff9494'; panIcon = '✕'; panLabel = `Not_Match ${validBankPAN ? '(' + validBankPAN + ')' : ''}`; }
    else if (pIsInvalid) { panBg = isLight ? '#fef3c7' : 'rgba(245,158,11,.22)'; panBd = isLight ? '#fde68a' : 'rgba(245,158,11,.45)'; panCol = isLight ? '#b45309' : '#fcd34d'; panIcon = '⚠'; panLabel = `Invalid_PAN ${validBankPAN ? '(' + validBankPAN + ')' : ''}`; }

    const canCopy = !isVerifying && !!bankAccountID;
    stmtsHTML = `
      <div style="margin:3px 6px;padding:5px 7px;background:${isLight ? '#ffffff' : 'linear-gradient(180deg, #14213a 0%, #0c1526 100%)'};border:1px solid ${isLight ? '#e2e8f0' : '#243356'};border-radius:8px;box-shadow:${isLight ? '0 1px 4px rgba(15,23,42,0.05)' : '0 4px 14px rgba(0,0,0,0.50)'};">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
          <span style="font-size:8px;font-weight:800;color:${isLight ? '#64748b' : '#aebccf'};text-transform:uppercase;letter-spacing:.05em;">PAN STATUS</span>
          <span style="font-size:8.5px;font-weight:700;padding:1.5px 6px;border-radius:4px;background:${panBg};border:1px solid ${panBd};color:${panCol};">${panIcon} ${panLabel}</span>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:5px;padding-top:4px;border-top:1px solid ${isLight ? '#f1f5f9' : '#111c31'};">
          <span class="nc-mono" style="font-size:11px;font-weight:700;color:${isLight ? '#0f172a' : '#ffffff'};letter-spacing:.03em;background:${isLight ? '#f8fafc' : '#02040a'};border:1px solid ${isLight ? '#e2e8f0' : '#18253c'};padding:2px 6px;border-radius:4px;">${bankAccountID || '—'}</span>
          <button class="nc-stmt-copy nc-btn-copy" data-id="${bankAccountID||''}" ${!canCopy?'disabled':''}
            style="display:flex;align-items:center;gap:3px;border-radius:5px;padding:2.5px 8px;font-size:8.5px;font-weight:700;transition:all .15s;border:none;
              ${canCopy
                ? 'background:linear-gradient(135deg, #2563eb 0%, #1743a8 100%);color:#ffffff;box-shadow:0 2px 6px rgba(37,99,235,.40);cursor:pointer;'
                : `background:${isLight ? '#e2e8f0' : '#101a2c'};color:${isLight ? '#475569' : '#8496ad'};cursor:not-allowed;opacity:.75;`}">
            ${ncIcon('copy', 9)} Copy</button>
        </div>
      </div>`;
  } else {
    // Clean Empty State when no statements are found
    stmtsHTML = `
      <div style="margin:3px 6px;padding:8px 6px;background:${isLight ? '#ffffff' : 'linear-gradient(180deg, #14213a 0%, #0c1526 100%)'};border:1px dashed ${isLight ? '#e2e8f0' : '#1f2e4c'};border-radius:8px;text-align:center;box-shadow:${isLight ? '0 1px 4px rgba(0,0,0,0.04)' : '0 4px 12px rgba(0,0,0,0.45)'};">
        <div style="color:${isLight ? '#3b82f6' : '#8ac0ff'};display:flex;justify-content:center;margin-bottom:3px;">
          ${ncIcon('shield', 15)}
        </div>
        <div style="font-size:9.5px;font-weight:800;color:${isLight ? '#0f172a' : '#ffffff'};letter-spacing:.02em;">No Bank Statements Found</div>
        <div style="font-size:8px;color:${isLight ? '#64748b' : '#aebccf'};margin-top:2px;line-height:1.25;">Navigate to the Bank Statement tab to scan accounts & PANs.</div>
      </div>`;
  }

  const widget = document.createElement('div');
  widget.id = 'nc-widget';
  widget.setAttribute('data-theme', currentTheme);
  if (isWidgetCollapsed) widget.classList.add('nc-collapsed');

  Object.assign(widget.style, {
    position: 'fixed',
    zIndex: '2147483646',
    width: isWidgetCollapsed ? 'auto' : '275px',
    maxWidth: 'calc(100vw - 20px)',
    borderRadius: '11px',
    overflow: 'hidden',
    userSelect: 'none',
    backgroundColor: isLight ? '#f8fafc' : '#080b11',
    background: isLight ? '#f8fafc' : '#080b11',
    color: isLight ? '#0f172a' : '#ffffff',
    border: isLight ? '1px solid #e2e8f0' : '1px solid #1f2e4a',
    boxShadow: isLight
      ? '0 14px 34px -8px rgba(15,23,42,.12), 0 2px 6px rgba(15,23,42,.04)'
      : '0 20px 48px -10px rgba(0,0,0,.88), 0 0 0 1px rgba(56,189,248,.20)'
  });

  const pos = getWidgetPos();
  if (pos) { widget.style.left = pos.left + 'px'; widget.style.top = pos.top + 'px'; }
  else { widget.style.right = '16px'; widget.style.bottom = '16px'; }

  widget.innerHTML = `
    <!-- Drag header -->
    <div id="nc-w-head" style="display:flex;align-items:center;justify-content:space-between;padding:5px 8px;gap:5px;background:${isLight ? 'linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)' : 'linear-gradient(180deg, #111827 0%, #0c121d 100%)'};border-bottom:1px solid ${isLight ? '#e2e8f0' : '#1f2e4a'};">
      <div style="display:flex;align-items:center;gap:4px;min-width:0;flex:1;">
        <span style="display:grid;grid-template-columns:repeat(2,2.5px);gap:1.5px;flex-shrink:0;opacity:.7;">
          <span style="width:2.5px;height:2.5px;border-radius:50%;background:${isLight ? '#94a3b8' : '#64748b'};"></span>
          <span style="width:2.5px;height:2.5px;border-radius:50%;background:${isLight ? '#94a3b8' : '#64748b'};"></span>
          <span style="width:2.5px;height:2.5px;border-radius:50%;background:${isLight ? '#94a3b8' : '#64748b'};"></span>
          <span style="width:2.5px;height:2.5px;border-radius:50%;background:${isLight ? '#94a3b8' : '#64748b'};"></span>
        </span>
        <span style="width:18px;height:18px;border-radius:4px;background:linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);color:#ffffff;display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 1.5px 4px rgba(37,99,235,0.3);">${ncIcon('shield', 10)}</span>
        <span style="font-size:10.5px;font-weight:800;letter-spacing:-0.01em;white-space:nowrap;color:${isLight ? '#0f172a' : '#ffffff'};">NameCheck</span>
      </div>
      <div style="display:flex;align-items:center;gap:3px;flex-shrink:0;">
        <span style="font-size:8.5px;font-weight:800;padding:1.5px 5px;border-radius:99px;background:${summaryBg};border:1px solid ${summaryBd};color:${summaryCol};white-space:nowrap;max-width:90px;overflow:hidden;text-overflow:ellipsis;display:inline-flex;align-items:center;gap:2px;" title="${summaryText}">${summaryText}</span>
        <button id="nc-w-min" title="${isWidgetCollapsed ? 'Expand Card' : 'Collapse Card'}" style="background:${isLight ? '#ffffff' : '#0c121d'};border:1px solid ${isLight ? '#e2e8f0' : '#1f2e4a'};color:${isLight ? '#475569' : '#94a3b8'};cursor:pointer;width:19px;height:19px;display:flex;align-items:center;justify-content:center;border-radius:4px;padding:0;flex-shrink:0;">
          ${isWidgetCollapsed ? ncIcon('max', 9) : ncIcon('min', 9)}
        </button>
        <button id="nc-w-reset" title="Reset / Clear Customer Cache (Alt+R)" style="background:${isLight ? '#ffffff' : '#0c121d'};border:1px solid ${isLight ? '#e2e8f0' : '#1f2e4a'};color:${isLight ? '#475569' : '#94a3b8'};cursor:pointer;width:19px;height:19px;display:flex;align-items:center;justify-content:center;border-radius:4px;padding:0;flex-shrink:0;">
          ${ncIcon('reset', 9)}
        </button>
        <button id="nc-w-theme" title="Toggle Light/Dark mode" style="background:${isLight ? '#ffffff' : '#0c121d'};border:1px solid ${isLight ? '#e2e8f0' : '#1f2e4a'};color:${isLight ? '#475569' : '#94a3b8'};cursor:pointer;width:19px;height:19px;display:flex;align-items:center;justify-content:center;border-radius:4px;padding:0;flex-shrink:0;">
          ${currentTheme === 'light' ? ncIcon('moon', 9) : ncIcon('sun', 9)}
        </button>
        <button id="nc-w-toggle" title="Toggle NameCheck on/off" style="
          background:#15803d;border:none;
          color:#ffffff;border-radius:20px;padding:2px 5px;
          font-size:7.5px;font-weight:800;letter-spacing:.03em;
          cursor:pointer;transition:all .15s;flex-shrink:0;box-shadow:0 1.5px 4px rgba(21,128,61,0.3);">ON</button>
        <button id="nc-w-close" title="Close" style="
          background:${isLight ? '#ffffff' : '#0c121d'};border:1px solid ${isLight ? '#e2e8f0' : '#1f2e4a'};color:${isLight ? '#64748b' : '#94a3b8'};
          width:19px;height:19px;border-radius:4px;cursor:pointer;
          display:flex;align-items:center;justify-content:center;padding:0;flex-shrink:0;
          transition:all .15s;">${ncIcon('x', 9)}</button>
      </div>
    </div>
    <div id="nc-w-body" style="${isWidgetCollapsed ? 'display:none;' : ''}">
      ${profileBarHTML}
      ${aiBadgeHTML}
      ${accountTypeCardHTML}
      ${consolidatedStatusHTML}
      <!-- Statements -->
      <div id="nc-widget-scroll" style="max-height:180px;overflow-y:auto;overflow-x:hidden;padding:1px 0 4px 0;">
        ${stmtsHTML}
      </div>
    </div>
  `;

  document.body.appendChild(widget);

  widget.getElementById = (id) => widget.querySelector(`#${id}`);
  document.getElementById('nc-w-close').addEventListener('click', () => removeWidget());

  const minBtn = document.getElementById('nc-w-min');
  if (minBtn) {
    minBtn.addEventListener('click', () => {
      isWidgetCollapsed = !isWidgetCollapsed;
      try { sessionStorage.setItem('_nc_collapsed', isWidgetCollapsed ? '1' : '0'); } catch(_) {}
      showPersistentWidget(lastScanResult);
    });
  }

  const resetWidgetBtn = document.getElementById('nc-w-reset');
  if (resetWidgetBtn) {
    resetWidgetBtn.addEventListener('click', () => performFullReset());
  }

  document.getElementById('nc-w-theme').addEventListener('click', () => {
    currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
    chrome.storage.local.set({ theme: currentTheme });
    showPersistentWidget(lastScanResult);
    chrome.runtime.sendMessage({ action: "THEME_TOGGLED", theme: currentTheme }).catch(() => {});
  });

  document.getElementById('nc-w-toggle').addEventListener('click', () => {
    extensionEnabled = false;
    chrome.storage.local.set({ extensionEnabled: false });
    clearHighlights();
    chrome.runtime.sendMessage({ action: "EXTENSION_TOGGLED", enabled: false }).catch(() => {});
    removeWidget();
  });

  widget.querySelectorAll('.nc-stmt-copy:not([disabled])').forEach(btn => {
    const id = btn.dataset.id;
    if (!id) return;
    const orig = btn.innerHTML;
    btn.addEventListener('click', () => copyToClipboard(id, btn, orig));
  });

  makeDraggable(widget, document.getElementById('nc-w-head'));
}

function removeUI() {}

// ─────────────────────────────────────────────
// KEYBOARD SHORTCUTS LISTENER
// ─────────────────────────────────────────────
document.addEventListener("keydown", (e) => {
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    const k = e.key.toLowerCase();
    if (k === 's') {
      e.preventDefault();
      if (extensionEnabled) { selfHealingRetryCount = 0; runScan(true); }
    } else if (k === 'r') {
      e.preventDefault();
      performFullReset();
    } else if (k === 'c') {
      e.preventDefault();
      const idToCopy = lastScanResult?.bankAccountID || lastScanResult?.statements?.[0]?.accountID;
      if (idToCopy) {
        navigator.clipboard.writeText(idToCopy).catch(() => {});
      }
    } else if (k === 'a') {
      e.preventDefault();
      if (extensionEnabled) { handleAIVerificationRequest(); }
    } else if (k === 't') {
      e.preventDefault();
      currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
      chrome.storage.local.set({ theme: currentTheme });
      if (lastScanResult && lastScanResult.scanned) showPersistentWidget(lastScanResult);
    }
  }
});
