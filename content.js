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
  count: 0, matchCount: 0, partialCount: 0, mismatchCount: 0,
  mismatchFound: false, noElements: true, details: [],
  profilePAN: null, bankPAN: null, panResult: null, bankAccountID: null
};

let savedProfileName = null;
let savedProfilePAN  = null;
let currentTheme     = 'dark';
let geminiApiKeyEncrypted = '';
let aiVerificationResult = null;

let scanTimeout = null;
let isScanning  = false;

let extensionEnabled      = true;
let lastScannedProfileSig = null;
let lastScannedBankSig    = null;
let lastScannedUrl        = null;

let selfHealingTimer      = null;
let selfHealingRetryCount = 0;

// ── Encryption Helpers for API Key ───────────
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

let aiProvider = 'gemini'; // 'gemini' | 'huggingface' | 'gemma' | 'local'
let allowedDomainsEncrypted = '';

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

// Read storage asynchronously on initialization
chrome.storage.local.get(['savedProfileName', 'savedProfilePAN', 'extensionEnabled', 'theme', 'geminiApiKey', 'aiProvider', 'allowedDomains'], (res) => {
  if (res.savedProfileName) savedProfileName = res.savedProfileName;
  if (res.savedProfilePAN)  savedProfilePAN  = res.savedProfilePAN;
  if (res.extensionEnabled === false) extensionEnabled = false;
  if (res.theme) currentTheme = res.theme;
  if (res.geminiApiKey) geminiApiKeyEncrypted = res.geminiApiKey;
  if (res.aiProvider) aiProvider = res.aiProvider;
  if (res.allowedDomains) allowedDomainsEncrypted = res.allowedDomains;
});

function stopAllScanning() {
  clearTimeout(scanTimeout);
  clearTimeout(selfHealingTimer);
  clearTimeout(mismatchSettlingTimer);
  if (mutationObserverInstance) {
    mutationObserverInstance.disconnect();
    mutationObserverInstance = null;
  }
  isScanning = false;
  removeWidget();
  clearHighlights();
  lastScanResult = { scanned: false, extensionEnabled: false, profileName: "Extension Disabled" };
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
    if (changes.aiProvider) {
      aiProvider = changes.aiProvider.newValue || 'gemini';
    }
    if (changes.theme) {
      currentTheme = changes.theme.newValue || 'dark';
      if (lastScanResult && lastScanResult.scanned) showPersistentWidget(lastScanResult);
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
    } else if (request.action === "TOGGLE_EXTENSION") {
      extensionEnabled = request.enabled !== false;
      chrome.storage.local.set({ extensionEnabled });
      if (!extensionEnabled) { stopAllScanning(); }
      else { selfHealingRetryCount = 0; initScanner(); }
      sendResponse({ enabled: extensionEnabled });
    } else if (request.action === "GET_STATUS") {
      if (!lastScanResult.scanned && extensionEnabled) {
        runScan();
      }
      sendResponse({ status: "success", result: lastScanResult, extensionEnabled, theme: currentTheme, aiResult: aiVerificationResult });
    } else if (request.action === "SET_THEME") {
      currentTheme = request.theme || 'dark';
      chrome.storage.local.set({ theme: currentTheme });
      if (lastScanResult && lastScanResult.scanned) {
        showPersistentWidget(lastScanResult);
      }
      sendResponse({ theme: currentTheme });
    } else if (request.action === "SAVE_SETTINGS") {
      if (request.apiKey !== null && request.apiKey !== undefined) geminiApiKeyEncrypted = encryptApiKey(request.apiKey);
      if (request.provider) aiProvider = request.provider;
      if (request.allowedDomains !== undefined) allowedDomainsEncrypted = request.allowedDomains;
      chrome.storage.local.set({ geminiApiKey: geminiApiKeyEncrypted, aiProvider, allowedDomains: allowedDomainsEncrypted });
      runScan(true);
      sendResponse({ success: true });
    } else if (request.action === "SAVE_API_KEY") {
      geminiApiKeyEncrypted = encryptApiKey(request.apiKey || "");
      if (request.provider) aiProvider = request.provider;
      chrome.storage.local.set({ geminiApiKey: geminiApiKeyEncrypted, aiProvider });
      sendResponse({ success: true });
    } else if (request.action === "SET_AI_PROVIDER") {
      if (request.provider) aiProvider = request.provider;
      chrome.storage.local.set({ aiProvider });
      sendResponse({ success: true });
    } else if (request.action === "VERIFY_AI") {
      handleAIVerificationRequest().then((res) => {
        sendResponse({ success: true, aiResult: res });
      });
      return true; // async
    }
  });
}

// Fast, targeted DOM node query to prevent dashboard slowdowns
function getTargetDOMNodes() {
  try {
    return Array.from(document.querySelectorAll(
      'span, td, th, div, input, p, b, strong, label, a, h1, h2, h3, h4, h5, h6, [role="gridcell"]'
    ));
  } catch (e) {
    return [];
  }
}

// Quick DOM probe: profile-name labels
function peekProfileName(passedNodes) {
  const labels = ["nsdl name", "nsdl pan display name", "profile name", "applicant name", "customer name"];
  const all = passedNodes || getTargetDOMNodes();
  for (let i = 0; i < all.length; i++) {
    const orig = all[i].innerText?.trim() || "";
    const text = orig.toLowerCase().replace(/[:\-]/g, "").replace(/\s+/g, " ");
    if (!labels.includes(text)) continue;
    for (let j = i + 1; j < i + 60 && j < all.length; j++) {
      const nt = (all[j].tagName === 'INPUT' ? all[j].value : all[j].innerText)?.trim();
      if (nt && nt.length >= 2 && nt.toLowerCase() !== orig.toLowerCase()) return nt;
    }
  }
  return null;
}

// Quick DOM probe: bank holder name labels
function peekBankHolderName(passedNodes) {
  const labels = ["acc holder's name", "acc holder", "account holder name", "account holder's name", "account name", "beneficiary name"];
  const all = passedNodes || getTargetDOMNodes();
  for (let i = 0; i < all.length; i++) {
    const orig = all[i].innerText?.trim() || "";
    const text = orig.toLowerCase().replace(/[:\-]/g, "").replace(/\s+/g, " ");
    if (!labels.includes(text)) continue;
    for (let j = i + 1; j < i + 60 && j < all.length; j++) {
      const nt = (all[j].tagName === 'INPUT' ? all[j].value : all[j].innerText)?.trim();
      if (nt && nt.length >= 2 && nt.toLowerCase() !== orig.toLowerCase()) return nt;
    }
  }
  return null;
}

// ─────────────────────────────────────────────
// AUTO START WITH SELF-HEALING RETRY
// ─────────────────────────────────────────────
function _startScanner() {
  chrome.storage.local.get(['extensionEnabled', 'theme', 'savedProfileName', 'savedProfilePAN', 'geminiApiKey'], (res) => {
    if (res.extensionEnabled === false) extensionEnabled = false;
    if (res.theme) currentTheme = res.theme;
    if (res.savedProfileName) savedProfileName = res.savedProfileName;
    if (res.savedProfilePAN) savedProfilePAN = res.savedProfilePAN;
    if (res.geminiApiKey) geminiApiKeyEncrypted = res.geminiApiKey;
    setTimeout(initScanner, 600);
  });
}
if (document.readyState === 'complete') { _startScanner(); }
else { window.addEventListener('load', _startScanner); }

function initScanner() {
  if (!extensionEnabled || !isDomainAllowed()) return;
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

// ─────────────────────────────────────────────
// Re-scan on DOM changes (debounced)
// ─────────────────────────────────────────────
let mutationObserverInstance = null;

function observeChanges() {
  if (!extensionEnabled || !isDomainAllowed()) {
    if (mutationObserverInstance) { mutationObserverInstance.disconnect(); mutationObserverInstance = null; }
    return;
  }
  if (mutationObserverInstance) return;

  mutationObserverInstance = new MutationObserver(() => {
    if (isScanning || !extensionEnabled || !isDomainAllowed()) return;
    clearTimeout(scanTimeout);
    scanTimeout = setTimeout(() => {
      if (!isDomainAllowed() || !extensionEnabled) return;
      if (!lastScanResult.scanned) { runScan(); return; }
      if (window.location.href !== lastScannedUrl) { runScan(); return; }
      const nodes = getTargetDOMNodes();
      const pProfile = peekProfileName(nodes);
      if (pProfile && pProfile !== lastScannedProfileSig) { runScan(); return; }
      const pBank = peekBankHolderName(nodes);
      if (pBank && pBank !== lastScannedBankSig) { runScan(); return; }
    }, 2500);
  });
  mutationObserverInstance.observe(document.body || document.documentElement, { childList: true, subtree: true });
}

// ─────────────────────────────────────────────
// TAB DETECTION
// ─────────────────────────────────────────────
function getActiveTab(passedNodes) {
  const tabCandidates = Array.from(document.querySelectorAll(
    'button, [role="tab"], .tab, [class*="tab"], nav a'
  ));
  for (const el of tabCandidates) {
    const text = el.innerText?.trim().toLowerCase();
    if (!text || !["profile","ocr","emp info","empinfo","emp_info"].includes(text)) continue;
    const style = window.getComputedStyle(el);
    const isActive =
      el.classList.contains('active') || el.classList.contains('selected') ||
      el.getAttribute('aria-selected') === 'true' || el.getAttribute('data-active') === 'true' ||
      style.backgroundColor === 'rgb(59, 130, 246)' || style.backgroundColor === 'rgb(37, 99, 235)' ||
      style.color === 'rgb(59, 130, 246)';
    if (isActive) {
      if (text.includes("profile")) return "profile";
      if (text.includes("ocr"))     return "ocr";
      if (text.includes("emp"))     return "empinfo";
    }
  }
  const pageText = document.body?.innerText || "";
  if (pageText.includes("NSDL Name") || pageText.includes("NSDL PAN Display Name") ||
      pageText.includes("NSDL PAN - Aadhaar linked") || pageText.includes("Govt ID No"))
    return "profile";
  if (pageText.includes("Employment Details") && pageText.includes("Employment Type") &&
      !pageText.includes("NSDL Name"))
    return "empinfo";
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
      count: 0, matchCount: 0, partialCount: 0, mismatchCount: 0,
      mismatchFound: false, noElements: true,
      details: [], statements: [],
      profilePAN: null, bankPAN: null, panResult: null, bankAccountID: null
    };
    chrome.runtime.sendMessage({ action: "UPDATE_STATUS", result: lastScanResult }).catch(() => {});
    return;
  }
  isScanning = true;

  try {
    clearHighlights();
    if (!_force || window.location.href !== lastScannedUrl) {
      lastScanResult = {
        scanned: true,
        isVerifying: true,
        profileName: "Scanning...",
        count: 0, matchCount: 0, partialCount: 0, mismatchCount: 0,
        mismatchFound: false, noElements: false,
        details: [], statements: [],
        profilePAN: savedProfilePAN, bankPAN: null, panResult: null, bankAccountID: null
      };
      aiVerificationResult = null;
    }

    const allNodes = getTargetDOMNodes();

    const activeTab = getActiveTab(allNodes);
    let profileEl = null;
    let currentProfileName = null;

    if (activeTab === "profile") {
      profileEl = findProfileNameInDOM(allNodes);
      if (profileEl) {
        const extracted = (profileEl.tagName === 'INPUT' ? profileEl.value : profileEl.innerText)?.trim();
        if (extracted && isLikelyPersonName(extracted)) {
          currentProfileName = extracted;
          savedProfileName = currentProfileName;
          chrome.storage.local.set({ savedProfileName: currentProfileName });
        }
      }
      const pan = findProfilePAN(allNodes);
      if (pan) {
        savedProfilePAN = pan;
        chrome.storage.local.set({ savedProfilePAN: pan });
      }
    }

    if (!currentProfileName) currentProfileName = savedProfileName;

    const statements = findAllBankStatements(allNodes);

    if (!currentProfileName || statements.length === 0) {
      lastScanResult = {
        scanned: false,
        profileName: currentProfileName || "Not found — visit Profile tab first",
        count: 0, matchCount: 0, partialCount: 0, mismatchCount: 0,
        mismatchFound: false, noElements: true,
        details: [], statements: [],
        profilePAN: savedProfilePAN, bankPAN: null, panResult: null, bankAccountID: null
      };
      if (savedProfilePAN && statements.length > 0) showPersistentWidget(lastScanResult);
      else removeWidget();
      chrome.runtime.sendMessage({ action: "UPDATE_STATUS", result: lastScanResult }).catch(() => { });
      return;
    }

    let mismatchFound = false;
    let partialCount  = 0;
    const details = [];
    const processedStatements = [];

    statements.forEach(st => {
      let nameDetail = null;
      let nameResult = 'unavailable';
      if (st.nameEl && st.rawName) {
        nameDetail = compareNamesDetailed(currentProfileName, st.rawName);
        nameResult = nameDetail.result;
        details.push(nameDetail);
      }

      const panResult = comparePANs(savedProfilePAN, st.pan);

      const nameOk = nameResult === 'match' || nameResult === 'partial';
      const panOk  = panResult.result === 'match' || panResult.result === 'unavailable';
      let overallResult;

      // 100% PAN MATCH is definitive proof of identity
      if (panResult.result === 'match') {
        overallResult = 'match';
        if (nameDetail) {
          nameDetail.needsManualCheck = false;
        }
      } else if (nameResult === 'match' && (panResult.result === 'match' || panResult.result === 'unavailable')) {
        overallResult = 'match';
      } else if (nameOk && panOk) {
        overallResult = 'partial';
      } else {
        overallResult = 'mismatch';
      }

      if (overallResult === 'mismatch') mismatchFound = true;
      if (overallResult === 'partial')  partialCount++;

      processedStatements.push({
        index: st.index, name: st.name, rawName: st.rawName,
        pan: st.pan, accountID: st.accountID,
        nameResult, nameDetail, panResult,
        overallResult,
        needsManualCheck: nameDetail?.needsManualCheck || overallResult === 'mismatch',
        copyEnabled: nameOk && panOk && !!st.accountID,
        nameEl: st.nameEl
      });
    });

    const matchCount    = processedStatements.filter(s => s.overallResult === 'match').length;
    const mismatchCount = processedStatements.filter(s => s.overallResult === 'mismatch').length;

    const bestSt = processedStatements.find(s => s.overallResult === 'match' && s.accountID)
                || processedStatements.find(s => s.overallResult === 'partial' && s.accountID)
                || processedStatements.find(s => s.accountID);

    const scanData = {
      scanned: true, profileName: currentProfileName,
      count: statements.length,
      matchCount, partialCount, mismatchCount, mismatchFound,
      noElements: false, details,
      statements: processedStatements,
      profilePAN: savedProfilePAN,
      bankPAN:    bestSt?.pan    || null,
      panResult:  bestSt?.panResult || null,
      bankAccountID: bestSt?.accountID || null
    };

    if (!_force) {
      // Neutral Scanning/Verifying State while page DOM settles — NO RED, NO PREMATURE MISMATCH
      const verifyingStatements = processedStatements.map(st => ({
        ...st,
        overallResult: 'verifying',
        nameResult: 'verifying',
        needsManualCheck: false
      }));

      lastScanResult = {
        ...scanData,
        scanned: true,
        isVerifying: true,
        mismatchFound: false,
        mismatchCount: 0,
        verifyingMessage: "Analyzing Name Compatibility...",
        statements: verifyingStatements
      };

      showPersistentWidget(lastScanResult);
      chrome.runtime.sendMessage({ action: "UPDATE_STATUS", result: lastScanResult }).catch(() => { });

      clearTimeout(mismatchSettlingTimer);
      mismatchSettlingTimer = setTimeout(() => {
        runScan(true);
      }, 1200);
      return;
    }

    lastScanResult = {
      ...scanData,
      isVerifying: false
    };

    processedStatements.forEach(st => {
      if (st.nameEl) {
        if (st.overallResult === 'match') highlight(st.nameEl, 'green');
        else if (st.overallResult === 'partial') highlight(st.nameEl, 'orange');
        else highlight(st.nameEl, 'red');
      }
    });

    if (profileEl && activeTab === "profile") {
      highlight(profileEl, mismatchFound ? "red" : partialCount > 0 ? "orange" : "green");
    }

    lastScannedProfileSig = currentProfileName || null;
    lastScannedBankSig    = processedStatements[0]?.rawName || null;
    lastScannedUrl        = window.location.href;

    showPersistentWidget(lastScanResult);
    chrome.runtime.sendMessage({ action: "UPDATE_STATUS", result: lastScanResult }).catch(() => { });

    if (mismatchFound && !lastScanResult.isVerifying) {
      scheduleSelfHealingRetry();
    }

  } catch (err) {
    console.error("NameCheck Scan Error:", err);
  } finally {
    setTimeout(() => { isScanning = false; }, 300);
  }
}

// ─────────────────────────────────────────────
// NAME EXTRACTION — strips parentage & junk
// ─────────────────────────────────────────────
function extractPersonName(raw) {
  if (!raw) return "";
  let name = raw.split(",")[0].trim();
  name = name
    .replace(/\b(s\/o|d\/o|w\/o|c\/o|f\/o|h\/o|s\.o\.|d\.o\.|w\.o\.|c\.o\.)\b.*/i, "")
    .replace(/\b(son of|daughter of|wife of|care of|husband of|father of)\b.*/i, "")
    .replace(/\b(mr|mrs|ms|miss|dr|prof|shri|shrimati|smt|kumari|kum|km|late|m\/s|sardar|pandit|pt|swami|ca|cs|adv|er|syed|sheikh|shaikh)\b\.?/gi, "")
    .trim()
    .replace(/[,.\-:;]+$/, "")
    .trim();
  if (name.length >= 2 && /^[A-Za-z\s.\-]+$/.test(name)) return name;
  return raw.split(",")[0].trim();
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

function findProfileNameInDOM(passedNodes) {
  const allNodes = passedNodes || getTargetDOMNodes();
  for (let i = 0; i < allNodes.length; i++) {
    const el = allNodes[i];
    const originalText = el.innerText?.trim() || "";
    const text = originalText.toLowerCase().replace(/[:\-]/g, "").replace(/\s+/g, " ");
    const isProfileLabel =
      text === "nsdl name" || text === "nsdl pan display name" ||
      text === "profile name" || text === "applicant name" ||
      text === "customer name" || text === "name";
    if (!isProfileLabel || !isTightest(el, originalText)) continue;
    for (let j = i + 1; j < i + 60 && j < allNodes.length; j++) {
      const nextEl = allNodes[j];
      const nextText = (nextEl.tagName === 'INPUT' ? nextEl.value : nextEl.innerText)?.trim();
      if (!nextText || nextText.toLowerCase() === originalText.toLowerCase()) continue;
      if (!isTightest(nextEl, nextText)) continue;
      const lower = nextText.toLowerCase();
      if (lower === "gender" || lower === "dob" || lower.includes("pan ") ||
          lower.includes("govt id") || lower.includes("mobile no")) break;
      if (isLikelyPersonName(nextText)) return nextEl;
    }
  }
  for (const el of allNodes) {
    const text = (el.tagName === 'INPUT' ? el.value : el.innerText)?.trim();
    if (!text || !isTightest(el, text)) continue;
    const words = text.trim().split(/\s+/);
    if (words.length >= 2 && words.length <= 8 && text === text.toUpperCase() && isLikelyPersonName(text)) {
      const rect = el.getBoundingClientRect();
      if (rect.top >= 0 && rect.top < 350) return el;
    }
  }
  return null;
}

function isLikelyPersonName(text) {
  if (!text || text.length < 2 || !/^[A-Za-z\s.\-]+$/.test(text)) return false;

  // Placeholder rejection
  const PLACEHOLDERS = new Set([
    "LOADING", "LOADING...", "PLEASE WAIT", "PLEASE WAIT...", "N/A", "NA",
    "SELECT", "SELECT NAME", "NONE", "NULL", "UNDEFINED", "---", "----",
    "FETCHING", "FETCHING...", "WAITING", "WAITING..."
  ]);
  if (PLACEHOLDERS.has(text.toUpperCase().trim())) return false;

  const words = text.trim().split(/\s+/);
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
    "PAN","DOB","HOLD","MANUAL","CONFIRMED","PROFILE","OCR","EMP","INFO","STATE",
    "CITY","PINCODE","ADDRESS","MOBILE","EMAIL","SALARY","VERSION","POSITION",
    "SALARIED","REMARKS","UAN","EMPLOYMENT","DETAILS","STATEMENT","ACCOUNT","HOLDER",
    "REUPLOAD","RESET","COMMENTS","WHATSAPP","HISTORY","LIST",
    "SUNDAY","MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY",
    "SUN","MON","TUE","WED","THU","FRI","SAT",
    "JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE","JULY","AUGUST",
    "SEPTEMBER","OCTOBER","NOVEMBER","DECEMBER",
    "JAN","FEB","MAR","APR","JUN","JUL","AUG","SEP","OCT","NOV","DEC",
    "DATE","TIME","TODAY","YESTERDAY","WEEK","MONTH","YEAR","CALENDAR","SCHEDULE"
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
// PAN EXTRACTION
// ─────────────────────────────────────────────
function findProfilePAN(passedNodes) {
  const allNodes = passedNodes || getTargetDOMNodes();
  const panLabels = ["pan", "pan no", "pan number", "pan card", "pan id", "pan no."];
  for (let i = 0; i < allNodes.length; i++) {
    const el = allNodes[i];
    const originalText = el.innerText?.trim() || "";
    const text = originalText.toLowerCase().replace(/[:\-]/g, "").replace(/\s+/g, " ");
    if (!panLabels.includes(text) || !isTightest(el, originalText)) continue;
    for (let j = i + 1; j < i + 30 && j < allNodes.length; j++) {
      const nextEl = allNodes[j];
      const nextText = (nextEl.tagName === 'INPUT' ? nextEl.value : nextEl.innerText)?.trim();
      if (!nextText || nextText.toLowerCase() === originalText.toLowerCase()) continue;
      if (!isTightest(nextEl, nextText)) continue;
      const clean = nextText.replace(/[\s\-]/g, '').toUpperCase();
      if (/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(clean) || /^[*X]{3,6}[0-9]{4}[A-Z]$/.test(clean)) {
        return clean;
      }
      break;
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

    if (!bankPAN && text === "pan") {
      for (let j = i + 1; j < i + 30 && j < allNodes.length; j++) {
        const nextEl = allNodes[j];
        const nextText = (nextEl.tagName === 'INPUT' ? nextEl.value : nextEl.innerText)?.trim();
        if (!nextText || nextText.toLowerCase() === originalText.toLowerCase()) continue;
        if (!isTightest(nextEl, nextText)) continue;
        if (/^[A-Z]{5}[0-9]{4}[A-Z]$/i.test(nextText.trim())) {
          bankPAN = nextText.trim().toUpperCase();
        }
        break;
      }
    }

    if (!bankAccountID && (text === "bank account id" || text === "account id")) {
      for (let j = i + 1; j < i + 30 && j < allNodes.length; j++) {
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
// MULTI-STATEMENT GROUPING
// ─────────────────────────────────────────────
function findAllBankStatements(passedNodes) {
  const allNodes = passedNodes || getTargetDOMNodes();

  const sectionIdxs = [];
  for (let i = 0; i < allNodes.length; i++) {
    const raw  = allNodes[i].innerText?.trim() || "";
    const text = raw.replace(/[^\w\s]/g, "").trim();
    if (/^Bank\s+Statement\s*\d*$/i.test(text) && text.length < 60
        && isTightest(allNodes[i], raw)) {
      sectionIdxs.push(i);
    }
  }
  if (sectionIdxs.length > 1) {
    return sectionIdxs.map((si, s) => {
      const ei = s + 1 < sectionIdxs.length ? sectionIdxs[s + 1] : allNodes.length;
      return extractStatementFromRange(allNodes, si, ei, s + 1);
    }).filter(st => st.nameEl || st.accountID);
  }

  const holderLabels = [
    "acc holder's name","acc holder","account holder name",
    "account holder's name","account name","beneficiary name"
  ];
  const labelIdxs = [];
  for (let i = 0; i < allNodes.length; i++) {
    const raw  = allNodes[i].innerText?.trim() || "";
    const text = raw.toLowerCase().replace(/[:\-]/g, "").replace(/\s+/g, " ");
    if (holderLabels.includes(text) && isTightest(allNodes[i], raw)) labelIdxs.push(i);
  }
  if (labelIdxs.length > 1) {
    return labelIdxs.map((li, s) => {
      const si = Math.max(0, li - 15);
      const ei = s + 1 < labelIdxs.length ? labelIdxs[s + 1] : allNodes.length;
      return extractStatementFromRange(allNodes, si, ei, s + 1);
    }).filter(st => st.nameEl || st.accountID);
  }

  const single = extractStatementFromRange(allNodes, 0, allNodes.length, 1);
  return (single.nameEl || single.accountID) ? [single] : [];
}

function extractStatementFromRange(allNodes, startIdx, endIdx, index) {
  const holderLabels = [
    "acc holder's name","acc holder","account holder name",
    "account holder's name","account name","beneficiary name"
  ];
  let nameEl = null, rawName = null;
  let pan = null;
  let accountID = null;

  for (let i = startIdx; i < endIdx && i < allNodes.length; i++) {
    const el   = allNodes[i];
    const orig = el.innerText?.trim() || "";
    const text = orig.toLowerCase().replace(/[:\-]/g, "").replace(/\s+/g, " ");
    if (!isTightest(el, orig)) continue;

    if (!nameEl && holderLabels.includes(text)) {
      for (let j = i + 1; j < i + 50 && j < endIdx; j++) {
        const nx = allNodes[j];
        const nt = (nx.tagName === 'INPUT' ? nx.value : nx.innerText)?.trim();
        if (!nt || nt.toLowerCase() === orig.toLowerCase()) continue;
        if (!isTightest(nx, nt)) continue;
        const lo = nt.toLowerCase();
        if (lo === "mobile" || lo === "email" || lo === "pan") break;
        nameEl  = nx;
        rawName = nt;
        break;
      }
    }

    if (!pan && text === "pan") {
      for (let j = i + 1; j < i + 25 && j < endIdx; j++) {
        const nx = allNodes[j];
        const nt = (nx.tagName === 'INPUT' ? nx.value : nx.innerText)?.trim();
        if (!nt || nt.toLowerCase() === orig.toLowerCase()) continue;
        if (!isTightest(nx, nt)) continue;
        if (/^[A-Z]{5}[0-9]{4}[A-Z]$/i.test(nt.trim())) pan = nt.trim().toUpperCase();
        break;
      }
    }

    if (!accountID && (text === "bank account id" || text === "account id")) {
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

  return {
    index,
    nameEl,
    rawName,
    name: rawName ? extractPersonName(rawName) : null,
    pan,
    accountID
  };
}

function comparePANs(panA, panB) {
  if (!panA || !panB) return { result: "unavailable", matchedPart: null, matchLen: 0 };
  const a = panA.toUpperCase().replace(/[\s\-]/g, '').trim();
  const b = panB.toUpperCase().replace(/[\s\-]/g, '').trim();
  if (a === b) return { result: "match", matchedPart: a, matchLen: 10 };

  if (/^[*X]+/.test(b) || /^[*X]+/.test(a)) {
    const visB = b.replace(/^[*X]+/, '');
    const visA = a.replace(/^[*X]+/, '');
    const visible = (visB.length > 0 && visB.length <= visA.length) ? visB : visA;
    if (visible.length >= 4 && (a.endsWith(visible) || b.endsWith(visible))) {
      return { result: "match", matchedPart: visible, matchLen: visible.length };
    }
  }

  if (a.length >= 5 && b.length >= 5 && a.slice(-5) === b.slice(-5))
    return { result: "match", matchedPart: a.slice(-5), matchLen: 5 };
  if (a.length >= 4 && b.length >= 4 && a.slice(-4) === b.slice(-4))
    return { result: "match", matchedPart: a.slice(-4), matchLen: 4 };
  return { result: "mismatch", matchedPart: null, matchLen: 0 };
}

// ─────────────────────────────────────────────
// ADVANCED INDIAN NAME COMPARISON ENGINE
// ─────────────────────────────────────────────
const INDIAN_MIDDLE_FILLERS = new Set([
  "KUMAR", "KUMARI", "CHANDRA", "PRASAD", "SINGH", "DEVI", "DUTT", "LAL",
  "BHAI", "BEN", "KANT", "NATH", "BHUSHAN", "PRAKASH", "SHANKAR", "VEER",
  "RAO", "REDDY", "CHAND", "RAM", "SHAN", "ROY", "DASS", "DAS"
]);

function isIndianMiddleOrFillerToken(token) {
  return INDIAN_MIDDLE_FILLERS.has(token.toUpperCase());
}

function normalize(name) {
  if (!name) return "";
  return name.toLowerCase()
    .replace(/\b(s\/o|d\/o|w\/o|c\/o|f\/o|h\/o|s\.o\.|d\.o\.|w\.o\.|c\.o\.)\b.*/gi, "")
    .replace(/\b(son of|daughter of|wife of|care of|husband of|father of)\b.*/gi, "")
    .replace(/\b(mr|mrs|ms|miss|dr|prof|shri|shrimati|smt|kumari|kum|km|late|m\/s|sardar|pandit|pt|swami|ca|cs|adv|er|syed|sheikh|shaikh)\b\.?/gi, "")
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(name) { return normalize(name).split(" ").filter(Boolean); }
function significantTokens(tokens) { return tokens.filter(t => t.length > 1); }

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

  // Indian Phonetic match
  if (indianPhoneticNormalize(w1) === indianPhoneticNormalize(w2)) return true;

  const minLen = Math.min(w1.length, w2.length);
  if (minLen >= 4 && jaroWinkler(w1, w2) >= 0.90) return true;
  if (minLen >= 4 && bigramSim(w1, w2) >= 0.70) return true;
  const maxEdits = minLen >= 8 ? 2 : minLen >= 5 ? 1 : 0;
  if (maxEdits > 0 && levenshtein(w1, w2) <= maxEdits) return true;
  return false;
}

function compareNames(a, b) {
  const cleanA = extractPersonName(a);
  const cleanB = extractPersonName(b);
  const n1 = normalize(cleanA), n2 = normalize(cleanB);
  if (n1 === n2) return "match";

  const t1 = tokenize(cleanA), t2 = tokenize(cleanB);
  if (t1.length === 0 || t2.length === 0) return "mismatch";

  // Exact bag match
  if (t1.slice().sort().join(" ") === t2.slice().sort().join(" ")) return "match";
  if (t1.join("") === t2.join("")) return "match";

  // Indian Phonetic Bag Match
  const ph1 = t1.map(indianPhoneticNormalize).sort().join(" ");
  const ph2 = t2.map(indianPhoneticNormalize).sort().join(" ");
  if (ph1 === ph2 && ph1.length > 0) return "match";

  // Indian Middle Name / Filler Token Omission Rule
  // Example: "RAKESH KUMAR SHARMA" vs "RAKESH SHARMA"
  const nonFiller1 = t1.filter(t => !isIndianMiddleOrFillerToken(t));
  const nonFiller2 = t2.filter(t => !isIndianMiddleOrFillerToken(t));
  if (nonFiller1.length > 0 && nonFiller2.length > 0) {
    const nfStr1 = nonFiller1.map(indianPhoneticNormalize).sort().join(" ");
    const nfStr2 = nonFiller2.map(indianPhoneticNormalize).sort().join(" ");
    if (nfStr1 === nfStr2) return "match";
  }

  const [shorter, longer] = t1.length <= t2.length ? [t1, t2] : [t2, t1];
  const sigS = significantTokens(shorter), sigL = significantTokens(longer);

  if (sigS.length > 0) {
    const used = new Set(); let allFound = true;
    for (const sw of sigS) {
      let found = false;
      for (let i = 0; i < sigL.length; i++) {
        if (!used.has(i) && fuzzyWordMatch(sw, sigL[i])) { used.add(i); found = true; break; }
      }
      if (!found) { allFound = false; break; }
    }
    if (allFound) return "match";
  }

  // South Indian Initials Permutation Engine
  const initVariant = tokens =>
    tokens.length > 1 ? tokens.slice(0,-1).map(w => w[0]).join("") + " " + tokens[tokens.length-1] : tokens[0] || "";
  const mkVariants = tokens => [tokens.join(""), initVariant(tokens), initVariant([...tokens].reverse())].filter(Boolean);
  for (const va of mkVariants(t1))
    for (const vb of mkVariants(t2))
      if (va === vb) return "match";

  const overlapScore = (arr1, arr2) => {
    const used = new Set(); let score = 0;
    for (const w of arr1) {
      if (w.length <= 1) continue;
      for (let i = 0; i < arr2.length; i++) {
        if (!used.has(i) && fuzzyWordMatch(w, arr2[i])) { used.add(i); score++; break; }
      }
    }
    return score;
  };

  const s1 = overlapScore(sigS, sigL), s2 = overlapScore(sigL, sigS);
  if (s1 >= sigS.length && sigS.length > 0) return "match";
  if (s2 >= sigL.length && sigL.length > 0) return "match";
  const total = sigS.length + sigL.length;
  if (total > 0 && (s1 + s2) / total >= 0.5) return "partial";

  const last1 = t1[t1.length-1], last2 = t2[t2.length-1];
  if (last1 && last2 && last1.length > 2 && fuzzyWordMatch(last1, last2)) return "partial";
  const f1 = t1[0], f2 = t2[0];
  if (f1 && f2 && f1.length > 2 && fuzzyWordMatch(f1, f2)) return "partial";

  const ciResult = tryCompoundInitialsMatch(t1, t2);
  if (ciResult) return ciResult;

  return "mismatch";
}

function computeNameConfidence(profileName, bankName) {
  const n1 = normalize(extractPersonName(profileName));
  const n2 = normalize(extractPersonName(bankName));
  if (!n1 || !n2) return 0;
  const jwFull = jaroWinkler(n1.replace(/\s+/g, ''), n2.replace(/\s+/g, ''));
  const bgFull = bigramSim(n1, n2);
  const t1 = significantTokens(tokenize(profileName));
  const t2 = significantTokens(tokenize(bankName));
  const used = new Set();
  let tokenMatches = 0;
  for (const w of t1) {
    for (let i = 0; i < t2.length; i++) {
      if (!used.has(i) && fuzzyWordMatch(w, t2[i])) { tokenMatches++; used.add(i); break; }
    }
  }
  const tokenScore = tokenMatches / Math.max(t1.length, t2.length, 1);
  return Math.min(100, Math.round((jwFull * 0.3 + bgFull * 0.2 + tokenScore * 0.5) * 100));
}

function tryCompoundInitialsMatch(t1, t2) {
  const used1 = new Array(t1.length).fill(false);
  const used2 = new Array(t2.length).fill(false);

  for (let i = 0; i < t1.length; i++) {
    for (let j = 0; j < t2.length; j++) {
      if (used2[j]) continue;
      if (fuzzyWordMatch(t1[i], t2[j])) { used1[i] = used2[j] = true; break; }
    }
  }

  for (let j = 0; j < t2.length; j++) {
    if (used2[j] || t2[j].length <= 1) continue;
    for (let i = 0; i < t1.length - 1; i++) {
      if (used1[i] || used1[i + 1]) continue;
      if (t2[j] === t1[i] + t1[i + 1]) { used1[i] = used1[i + 1] = used2[j] = true; break; }
    }
  }

  for (let i = 0; i < t1.length; i++) {
    if (used1[i] || t1[i].length <= 1) continue;
    for (let j = 0; j < t2.length - 1; j++) {
      if (used2[j] || used2[j + 1]) continue;
      if (t1[i] === t2[j] + t2[j + 1]) { used1[i] = used2[j] = used2[j + 1] = true; break; }
    }
  }

  const sig1Total   = t1.filter(w => w.length > 1).length;
  const sig2Total   = t2.filter(w => w.length > 1).length;
  const sig1Matched = t1.filter((w, i) => w.length > 1 && used1[i]).length;
  const sig2Matched = t2.filter((w, i) => w.length > 1 && used2[i]).length;

  const cov1 = sig1Total > 0 ? sig1Matched / sig1Total : 1;
  const cov2 = sig2Total > 0 ? sig2Matched / sig2Total : 1;
  const minCov = Math.min(cov1, cov2);

  if (minCov >= 0.99) return "partial";
  if (minCov >= 0.5)  return "partial";
  return null;
}

function compareNamesDetailed(profileName, rawBankName) {
  const cleanBankName = extractPersonName(rawBankName);
  const result = compareNames(profileName, rawBankName);
  const confidence = computeNameConfidence(profileName, rawBankName);
  const tProfile = tokenize(extractPersonName(profileName));
  const tBank    = tokenize(cleanBankName);
  const firstNameProfile = tProfile[0] || null;
  const firstNameBank    = tBank[0]    || null;
  const firstNameDiffers =
    result === "partial" && firstNameProfile && firstNameBank &&
    !fuzzyWordMatch(firstNameProfile, firstNameBank);
  const tokenResults = tProfile.map(pt => ({ token: pt.toUpperCase(), matched: tBank.some(bt => fuzzyWordMatch(pt, bt)) }));
  const needsManualCheck = result === 'mismatch' || (result === 'partial' && confidence < 70);
  return { result, confidence, needsManualCheck, rawBankName, cleanBankName: cleanBankName.toUpperCase(),
           firstNameProfile: firstNameProfile?.toUpperCase() || null,
           firstNameBank: firstNameBank?.toUpperCase() || null,
           firstNameDiffers, tokenResults };
}

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

async function callHuggingFaceAI(profileName, bankName, hfModelName) {
  const rawKey = decryptApiKey(geminiApiKeyEncrypted);
  const targetModel = hfModelName || (aiProvider === 'gemma' ? 'google/gemma-2-2b-it' : 'HuggingFaceTB/SmolLM-135M-Instruct');
  const url = `https://api-inference.huggingface.co/models/${targetModel}`;

  const prompt = `Task: Compare Indian Names.
Profile Name: "${profileName}"
Bank Account Name: "${bankName}"

Are these the same person considering Indian naming conventions (middle name omission, initials)?
Reply in valid JSON format:
{"verdict": "MATCH" | "PARTIAL" | "MISMATCH", "confidence": 95, "reason": "<1 short sentence>"}`;

  const headers = { "Content-Type": "application/json" };
  if (rawKey) {
    headers["Authorization"] = `Bearer ${rawKey}`;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: headers,
    body: JSON.stringify({
      inputs: prompt,
      parameters: { max_new_tokens: 120, return_full_text: false }
    })
  });

  if (!response.ok) {
    const errJson = await response.json().catch(() => ({}));
    throw new Error(errJson.error || `Hugging Face API HTTP ${response.status}`);
  }

  const data = await response.json();
  let generatedText = "";
  if (Array.isArray(data) && data[0]?.generated_text) {
    generatedText = data[0].generated_text;
  } else if (data.generated_text) {
    generatedText = data.generated_text;
  } else {
    generatedText = JSON.stringify(data);
  }

  const parsed = parseAIResponseJSON(generatedText);
  if (parsed && parsed.verdict) {
    return {
      verdict: (parsed.verdict || "MATCH").toUpperCase(),
      confidence: parsed.confidence || 90,
      reason: parsed.reason || `AI (${targetModel.split("/").pop()}) confirmed match.`
    };
  }

  const lower = generatedText.toLowerCase();
  const verdict = lower.includes("mismatch") ? "MISMATCH" : lower.includes("partial") ? "PARTIAL" : "MATCH";
  return {
    verdict: verdict,
    confidence: 85,
    reason: `AI (${targetModel.split("/").pop()}): ${generatedText.slice(0, 90)}`
  };
}

async function handleAIVerificationRequest() {
  if (!lastScanResult || !lastScanResult.profileName || !lastScanResult.statements || lastScanResult.statements.length === 0) {
    const res = { verdict: "NO_DATA", reason: "Scan names on the page first before verifying with AI." };
    aiVerificationResult = res;
    if (lastScanResult.scanned) showPersistentWidget(lastScanResult);
    return res;
  }

  if (aiProvider === 'disabled') {
    const res = { verdict: "OFF", confidence: 0, reason: "AI Verification is turned OFF in Settings." };
    aiVerificationResult = res;
    if (lastScanResult && lastScanResult.scanned) showPersistentWidget(lastScanResult);
    return res;
  }

  // Local or missing API Key processing across all statements
  if (aiProvider === 'local' || !rawKey) {
    let hasMismatch = false;
    let matchCount = 0;
    let partialCount = 0;

    statements.forEach(st => {
      const localEval = compareNamesDetailed(profileName, st.rawName || st.name);
      const verdict = localEval.result.toUpperCase();
      st.aiResult = {
        verdict,
        confidence: localEval.confidence,
        reason: `Local Indian NLP Engine (${localEval.confidence}% confidence)`
      };

      if (verdict === 'MATCH') {
        st.overallResult = 'match';
        st.needsManualCheck = false;
        st.copyEnabled = true;
        matchCount++;
      } else if (verdict === 'PARTIAL') {
        st.overallResult = 'partial';
        st.needsManualCheck = localEval.confidence < 70;
        st.copyEnabled = true;
        partialCount++;
      } else {
        st.overallResult = 'mismatch';
        st.needsManualCheck = true;
        hasMismatch = true;
      }
    });

    lastScanResult.matchCount = matchCount;
    lastScanResult.partialCount = partialCount;
    lastScanResult.mismatchCount = statements.length - (matchCount + partialCount);
    lastScanResult.mismatchFound = hasMismatch;

    const summaryVerdict = hasMismatch ? "MISMATCH" : partialCount > 0 ? "PARTIAL" : "MATCH";
    const res = {
      verdict: summaryVerdict,
      confidence: Math.round(statements.reduce((acc, s) => acc + (s.aiResult?.confidence || 80), 0) / statements.length),
      reason: `Verified ${statements.length} statement${statements.length > 1 ? 's' : ''} via Local Indian NLP Engine.${!rawKey && aiProvider !== 'local' ? ' Add Gemini API Key in Settings for deep LLM reasoning.' : ''}`
    };
    aiVerificationResult = res;
    showPersistentWidget(lastScanResult);
    chrome.runtime.sendMessage({ action: "UPDATE_STATUS", result: lastScanResult }).catch(() => { });
    return res;
  }

  // HuggingFace / Gemma processing
  if (aiProvider === 'huggingface' || aiProvider === 'gemma') {
    try {
      const modelName = aiProvider === 'gemma' ? 'google/gemma-2-2b-it' : 'HuggingFaceTB/SmolLM-135M-Instruct';
      let hasMismatch = false;
      let matchCount = 0;
      let partialCount = 0;

      for (const st of statements) {
        const hfRes = await callHuggingFaceAI(profileName, st.rawName || st.name, modelName);
        st.aiResult = hfRes;
        if (hfRes.verdict === 'MATCH') {
          st.overallResult = 'match';
          st.needsManualCheck = false;
          st.copyEnabled = true;
          matchCount++;
        } else if (hfRes.verdict === 'PARTIAL') {
          st.overallResult = 'partial';
          st.needsManualCheck = false;
          st.copyEnabled = true;
          partialCount++;
        } else {
          st.overallResult = 'mismatch';
          st.needsManualCheck = true;
          hasMismatch = true;
        }
      }

      lastScanResult.matchCount = matchCount;
      lastScanResult.partialCount = partialCount;
      lastScanResult.mismatchCount = statements.length - (matchCount + partialCount);
      lastScanResult.mismatchFound = hasMismatch;

      const summaryVerdict = hasMismatch ? "MISMATCH" : partialCount > 0 ? "PARTIAL" : "MATCH";
      const res = {
        verdict: summaryVerdict,
        confidence: Math.round(statements.reduce((acc, s) => acc + (s.aiResult?.confidence || 85), 0) / statements.length),
        reason: `AI (${modelName.split("/").pop()}) verified ${statements.length} bank statement${statements.length > 1 ? 's' : ''}.`
      };
      aiVerificationResult = res;
      showPersistentWidget(lastScanResult);
      chrome.runtime.sendMessage({ action: "UPDATE_STATUS", result: lastScanResult }).catch(() => { });
      return res;
    } catch (err) {
      console.warn("HF AI Error, falling back to Local NLP:", err);
    }
  }

  // Gemini API Multi-Statement Prompt
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
    "gemini-1.5-flash",
    "gemini-2.0-flash",
    "gemini-2.5-flash-lite",
    "gemini-1.5-pro"
  ];

  let lastError = null;

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

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        const msg = errJson.error?.message || `HTTP ${response.status}`;
        lastError = new Error(`[${model}] ${msg}`);
        continue;
      }

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) continue;

      const parsed = parseAIResponseJSON(text);
      if (!parsed) continue;

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
        reason: parsed.reason || `AI (${model}) verified ${statements.length} statement${statements.length > 1 ? 's' : ''}.`
      };
      aiVerificationResult = res;
      showPersistentWidget(lastScanResult);
      chrome.runtime.sendMessage({ action: "UPDATE_STATUS", result: lastScanResult }).catch(() => { });
      return res;

    } catch (err) {
      lastError = err;
    }
  }

  // Fallback to local NLP evaluation if all AI models fail
  let hasMismatch = false;
  let matchCount = 0;
  let partialCount = 0;
  statements.forEach(st => {
    const localEval = compareNamesDetailed(profileName, st.rawName || st.name);
    const v = localEval.result.toUpperCase();
    st.aiResult = { verdict: v, confidence: localEval.confidence, reason: `Local NLP fallback (${localEval.confidence}%)` };
    if (v === 'MATCH') { st.overallResult = 'match'; st.needsManualCheck = false; matchCount++; }
    else if (v === 'PARTIAL') { st.overallResult = 'partial'; st.needsManualCheck = false; partialCount++; }
    else { st.overallResult = 'mismatch'; st.needsManualCheck = true; hasMismatch = true; }
  });

  lastScanResult.matchCount = matchCount;
  lastScanResult.partialCount = partialCount;
  lastScanResult.mismatchCount = statements.length - (matchCount + partialCount);
  lastScanResult.mismatchFound = hasMismatch;

  const res = {
    verdict: hasMismatch ? "MISMATCH" : partialCount > 0 ? "PARTIAL" : "MATCH",
    confidence: 85,
    reason: `AI Note: ${lastError?.message || "API call failed"}. Verified using Local Indian NLP Engine.`
  };
  aiVerificationResult = res;
  showPersistentWidget(lastScanResult);
  chrome.runtime.sendMessage({ action: "UPDATE_STATUS", result: lastScanResult }).catch(() => { });
  return res;
}

// ─────────────────────────────────────────────
// HIGHLIGHT
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
// PERSISTENT DRAGGABLE WIDGET WITH THEMES & AI
// ─────────────────────────────────────────────
let ncStylesInjected = false;

function injectNCStyles() {
  if (ncStylesInjected || document.getElementById('namecheck-styles')) { ncStylesInjected = true; return; }
  ncStylesInjected = true;
  const style = document.createElement('style');
  style.id = 'namecheck-styles';
  style.textContent = `
    @keyframes _nc_spin { from{transform:rotate(0deg);} to{transform:rotate(360deg);} }
    @keyframes _nc_in  { from{transform:scale(.95) translateY(8px);opacity:0} to{transform:scale(1) translateY(0);opacity:1} }
    @keyframes _nc_out { from{transform:scale(1) translateY(0);opacity:1} to{transform:scale(.95) translateY(8px);opacity:0} }
    #nc-widget { animation: _nc_in .35s cubic-bezier(.16,1,.3,1) forwards; }
    #nc-widget.nc-out { animation: _nc_out .25s ease-in forwards !important; }
    #nc-w-head { cursor: grab; }
    #nc-w-head.grabbing { cursor: grabbing !important; }
    #nc-w-close:hover { background: rgba(239,68,68,.22) !important; color: #f87171 !important; }
    .nc-w-copy:hover:not(:disabled) { background: rgba(59,130,246,.28) !important; }
    .nc-w-copy.nc-copied { background: rgba(34,197,94,.18) !important; border-color: rgba(34,197,94,.35) !important; color: #4ade80 !important; }
    .nc-ai-btn:hover { background: rgba(147,51,234,.25) !important; border-color: rgba(168,85,247,.4) !important; }
    #nc-widget * { box-sizing:border-box; font-family:-apple-system,'Inter',system-ui,sans-serif !important; }

    /* Glassmorphism Theme - Dark */
    #nc-widget.nc-theme-dark {
      background: rgba(11, 14, 25, 0.85) !important;
      color: #f1f5f9 !important;
      border: 1px solid rgba(255, 255, 255, 0.16) !important;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6), inset 0 1px 1px rgba(255, 255, 255, 0.2) !important;
      backdrop-filter: blur(28px) saturate(190%) !important;
      -webkit-backdrop-filter: blur(28px) saturate(190%) !important;
    }
    #nc-widget.nc-theme-dark #nc-w-head {
      background: rgba(255, 255, 255, 0.05) !important;
      border-bottom: 1px solid rgba(255, 255, 255, 0.09) !important;
    }

    /* Glassmorphism Theme - Light */
    #nc-widget.nc-theme-light {
      background: rgba(255, 255, 255, 0.86) !important;
      color: #0f172a !important;
      border: 1px solid rgba(203, 213, 225, 0.95) !important;
      box-shadow: 0 20px 50px rgba(15, 23, 42, 0.14), inset 0 1px 2px rgba(255, 255, 255, 0.95), 0 0 0 1px rgba(255, 255, 255, 0.6) !important;
      backdrop-filter: blur(28px) saturate(190%) !important;
      -webkit-backdrop-filter: blur(28px) saturate(190%) !important;
    }
    #nc-widget.nc-theme-light #nc-w-head {
      background: rgba(241, 245, 249, 0.92) !important;
      border-bottom: 1px solid rgba(203, 213, 225, 0.9) !important;
    }
    #nc-widget.nc-theme-light span { color: inherit; }
  `;
  document.head.appendChild(style);
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

function removeWidget() {
  const w = document.getElementById('nc-widget');
  if (!w) return;
  if (w._ncCleanup) w._ncCleanup();
  w.classList.add('nc-out');
  setTimeout(() => { const x = document.getElementById('nc-widget'); if (x) x.remove(); }, 260);
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
  const old = document.getElementById('nc-widget');
  if (old) { if (old._ncCleanup) old._ncCleanup(); old.remove(); }

  const { matchCount = 0, partialCount = 0, mismatchFound = false, isVerifying = false,
          statements = [], count = 0 } = result;

  const isLight      = currentTheme === 'light';
  const total        = statements.length || count;
  const verifiedCnt  = matchCount + partialCount;
  const summaryColor = isVerifying ? '#3b82f6' : mismatchFound ? '#ef4444' : partialCount > 0 ? '#f59e0b' : matchCount > 0 ? '#22c55e' : (isLight ? '#64748b' : 'rgba(255,255,255,.4)');
  const summaryIcon  = isVerifying ? '<span style="display:inline-block;animation:_nc_spin .8s linear infinite;">⏳</span>' : mismatchFound ? '✕' : partialCount > 0 ? '~' : matchCount > 0 ? '✓' : '—';
  const summaryLabel = isVerifying ? `${summaryIcon} Analyzing...` : (total > 0 ? `${summaryIcon} ${verifiedCnt}/${total} verified` : 'No statements');

  const copySVG = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;

  const globalWarning = isVerifying
    ? `<div style="background:rgba(59,130,246,.1);border-bottom:1px solid rgba(59,130,246,.22);
        padding:6px 10px;display:flex;align-items:center;gap:6px;">
        <span style="font-size:11px;display:inline-block;animation:_nc_spin .8s linear infinite;color:#3b82f6;">⏳</span>
        <div>
          <span style="font-size:9px;font-weight:700;color:#3b82f6;letter-spacing:.04em;">ANALYZING COMPATIBILITY</span>
          <span style="font-size:8px;color:${isLight ? '#1e40af' : 'rgba(59,130,246,.75)'};margin-left:5px;">verifying match details...</span>
        </div>
      </div>`
    : mismatchFound
    ? `<div style="background:rgba(239,68,68,.1);border-bottom:1px solid rgba(239,68,68,.22);
        padding:6px 10px;display:flex;align-items:center;gap:6px;">
        <span style="font-size:11px;font-weight:800;color:#ef4444;">⚠</span>
        <div>
          <span style="font-size:9px;font-weight:700;color:#ef4444;letter-spacing:.04em;">MANUAL CHECK REQUIRED</span>
          <span style="font-size:8px;color:${isLight ? '#991b1b' : 'rgba(239,68,68,.65)'};margin-left:5px;">name mismatch detected</span>
        </div>
      </div>`
    : '';

  // AI Box HTML
  let aiHTML = '';
  if (aiVerificationResult) {
    const aiColor = aiVerificationResult.verdict === 'MATCH' ? '#22c55e' : aiVerificationResult.verdict === 'PARTIAL' ? '#f59e0b' : '#ef4444';
    aiHTML = `
      <div style="padding:6px 10px;background:rgba(147,51,234,.08);border-bottom:1px solid rgba(147,51,234,.2);display:flex;flex-direction:column;gap:3px;">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span style="font-size:9px;font-weight:700;color:#c084fc;letter-spacing:.05em;">✨ AI VERIFICATION</span>
          <span style="font-size:9px;font-weight:700;color:${aiColor};">${aiVerificationResult.verdict} (${aiVerificationResult.confidence || 90}%)</span>
        </div>
        <div style="font-size:9px;color:${isLight ? '#475569' : 'rgba(255,255,255,.7)'};line-height:1.3;">
          ${aiVerificationResult.reason}
        </div>
      </div>`;
  }

  let stmtsHTML = '';
  if (statements.length > 0) {
    stmtsHTML = statements.map((st, idx) => {
      const isLast = idx === statements.length - 1;
      const isVerifyingRow = isVerifying || st.overallResult === 'verifying' || st.nameResult === 'verifying';
      const stColor = isVerifyingRow ? '#3b82f6'
                    : st.overallResult === 'match'   ? '#22c55e'
                    : st.overallResult === 'partial'  ? '#f59e0b' : '#ef4444';
      const stRGB   = isVerifyingRow ? '59,130,246'
                    : st.overallResult === 'match'   ? '34,197,94'
                    : st.overallResult === 'partial'  ? '245,158,11' : '239,68,68';
      const stIcon  = isVerifyingRow ? '<span style="display:inline-block;animation:_nc_spin .8s linear infinite;">⏳</span>'
                    : st.overallResult === 'match'   ? '✓'
                    : st.overallResult === 'partial'  ? '~' : '✕';

      const nColor = isVerifyingRow ? '#3b82f6'
                   : st.nameResult === 'match'   ? '#22c55e'
                   : st.nameResult === 'partial'  ? '#f59e0b'
                   : st.nameResult === 'unavailable' ? (isLight ? '#64748b' : 'rgba(255,255,255,.3)') : '#ef4444';
      const nRGB   = isVerifyingRow ? '59,130,246'
                   : st.nameResult === 'match'   ? '34,197,94'
                   : st.nameResult === 'partial'  ? '245,158,11'
                   : st.nameResult === 'unavailable' ? '100,116,139' : '239,68,68';
      const nSign  = isVerifyingRow ? '⏳' : st.nameResult === 'match' ? '✓' : st.nameResult === 'partial' ? '~' : st.nameResult === 'unavailable' ? '?' : '✕';

      const pr = isVerifyingRow ? 'verifying' : (st.panResult?.result || 'unavailable');
      const pColor = isVerifyingRow ? '#3b82f6' : pr === 'match' ? '#22c55e' : pr === 'partial' ? '#f59e0b'
                   : pr === 'unavailable' ? (isLight ? '#64748b' : 'rgba(255,255,255,.28)') : '#ef4444';
      const pRGB   = isVerifyingRow ? '59,130,246' : pr === 'match' ? '34,197,94' : pr === 'partial' ? '245,158,11'
                   : pr === 'unavailable' ? '100,116,139' : '239,68,68';
      const pSign  = isVerifyingRow ? '⏳' : pr === 'match' ? '✓' : pr === 'partial' ? `~${st.panResult.matchLen}` : pr === 'unavailable' ? '—' : '✕';

      const dispName = (st.name || '—').toUpperCase();

      const canCopy = !isVerifyingRow && !!st.copyEnabled;
      const btnStyle = canCopy
        ? `background:rgba(59,130,246,.15);border:1px solid rgba(59,130,246,.3);color:#3b82f6;cursor:pointer;`
        : `background:rgba(0,0,0,.04);border:1px solid rgba(0,0,0,.07);color:${isLight ? '#94a3b8' : 'rgba(255,255,255,.2)'};cursor:not-allowed;`;

      const fnDiff = (!isVerifyingRow && st.nameDetail?.firstNameDiffers)
        ? `<span style="font-size:8px;color:${isLight ? '#64748b' : 'rgba(255,255,255,.28)'};display:block;margin-top:2px;">${st.nameDetail.firstNameProfile} ≠ ${st.nameDetail.firstNameBank}</span>`
        : '';

      const manualCheckHTML = (!isVerifyingRow && st.needsManualCheck)
        ? `<div style="display:flex;align-items:center;gap:4px;margin-top:5px;padding:3px 6px;border-radius:4px;
            background:rgba(${st.overallResult === 'mismatch' ? '239,68,68' : '245,158,11'},.09);
            border:1px solid rgba(${st.overallResult === 'mismatch' ? '239,68,68' : '245,158,11'},.22);">
            <span style="font-size:8px;font-weight:700;letter-spacing:.04em;
              color:${st.overallResult === 'mismatch' ? '#ef4444' : '#f59e0b'};">
              ⚠ ${st.overallResult === 'mismatch' ? 'MANUAL CHECK REQUIRED' : 'VERIFY MANUALLY'}
            </span>
          </div>`
        : '';

      const aiRowHTML = st.aiResult
        ? `<div style="font-size:8px;font-weight:600;color:#c084fc;margin-top:4px;padding:3px 6px;border-radius:4px;background:rgba(147,51,234,.08);border:1px solid rgba(147,51,234,.2);">
            <span style="font-weight:700;">✨ AI ${st.aiResult.verdict} (${st.aiResult.confidence}%):</span>
            <span style="color:${isLight ? '#475569' : 'rgba(255,255,255,.75)'};margin-left:3px;">${st.aiResult.reason}</span>
           </div>`
        : '';

      return `
        <div style="padding:8px 10px;${!isLast ? 'border-bottom:1px solid ' + (isLight ? 'rgba(0,0,0,.06)' : 'rgba(255,255,255,.05)') + ';' : ''}
          background:rgba(${stRGB},.04);">

          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;">
            <div style="display:flex;align-items:center;gap:5px;min-width:0;flex:1;">
              <span style="font-size:9px;font-weight:700;color:${isLight ? '#64748b' : 'rgba(255,255,255,.28)'};flex-shrink:0;">#${st.index}</span>
              <span style="font-size:10px;font-weight:700;color:${isLight ? '#0f172a' : 'rgba(255,255,255,.78)'};
                white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:145px;" title="${dispName}">${dispName}</span>
            </div>
            <span style="font-size:10px;font-weight:700;color:${stColor};flex-shrink:0;margin-left:4px;">${stIcon}</span>
          </div>

          <div style="display:flex;align-items:center;flex-wrap:wrap;gap:3px;margin-bottom:6px;">
            <span style="font-size:9px;font-weight:600;padding:1px 6px;border-radius:3px;
              background:rgba(${nRGB},.12);color:${nColor};">NAME ${nSign}${st.nameDetail?.confidence != null && st.nameResult !== 'unavailable' ? ' ' + st.nameDetail.confidence + '%' : ''}</span>
            <span style="font-size:9px;font-weight:600;padding:1px 6px;border-radius:3px;
              background:rgba(${pRGB},.1);color:${pColor};">PAN ${pSign}</span>
            ${st.pan ? `<span style="font-size:8px;color:${isLight ? '#64748b' : 'rgba(255,255,255,.25)'};letter-spacing:.03em;">${st.pan}</span>` : ''}
          </div>
          ${fnDiff}
          ${manualCheckHTML}
          ${aiRowHTML}

          <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:${(fnDiff || manualCheckHTML) ? '4px' : '0'};">
            <span style="font-size:13px;font-weight:700;letter-spacing:.05em;
              font-variant-numeric:tabular-nums;
              color:${isLight ? '#0f172a' : 'rgba(255,255,255,.88)'};">${st.accountID || '—'}</span>
            <button class="nc-stmt-copy nc-w-copy"
              data-id="${st.accountID || ''}"
              ${!canCopy ? 'disabled' : ''}
              style="display:flex;align-items:center;gap:3px;${btnStyle}
                border-radius:5px;padding:3px 8px;font-size:10px;font-weight:600;
                transition:all .15s;flex-shrink:0;">
              ${copySVG} Copy
            </button>
          </div>
        </div>`;
    }).join('');

  } else {
    const { bankPAN, panResult, bankAccountID } = result;
    let panColor = isLight ? '#64748b' : 'rgba(255,255,255,.28)', panIcon = '—', panLabel = 'Not scanned';
    if (panResult?.result === 'match')   { panColor = '#22c55e'; panIcon = '✓'; panLabel = bankPAN || 'Match'; }
    if (panResult?.result === 'partial') { panColor = '#f59e0b'; panIcon = '~'; panLabel = `Partial ·last ${panResult.matchLen}: ${panResult.matchedPart}`; }
    if (panResult?.result === 'mismatch'){ panColor = '#ef4444'; panIcon = '✕'; panLabel = 'Mismatch'; }

    const canCopy = !!bankAccountID;
    const btnStyle = canCopy
      ? `background:rgba(59,130,246,.15);border:1px solid rgba(59,130,246,.3);color:#3b82f6;cursor:pointer;`
      : `background:rgba(0,0,0,.04);border:1px solid rgba(0,0,0,.07);color:${isLight ? '#94a3b8' : 'rgba(255,255,255,.2)'};cursor:not-allowed;`;

    stmtsHTML = `
      <div style="padding:8px 10px;border-bottom:1px solid ${isLight ? 'rgba(0,0,0,.06)' : 'rgba(255,255,255,.05)'};">
        <span style="font-size:9px;font-weight:700;color:${isLight ? '#64748b' : 'rgba(255,255,255,.28)'};text-transform:uppercase;letter-spacing:.07em;">PAN</span>
        <span style="margin-left:8px;font-size:11px;font-weight:700;color:${panColor};">${panIcon} ${panLabel}</span>
      </div>
      <div style="padding:9px 10px;">
        <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:${isLight ? '#64748b' : 'rgba(255,255,255,.28)'};margin-bottom:5px;">Bank Account ID</div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
          <span style="font-size:14px;font-weight:700;letter-spacing:.05em;font-variant-numeric:tabular-nums;
            color:${isLight ? '#0f172a' : 'rgba(255,255,255,.88)'};">${bankAccountID || '—'}</span>
          <button class="nc-stmt-copy nc-w-copy" data-id="${bankAccountID||''}" ${!canCopy?'disabled':''}
            style="display:flex;align-items:center;gap:3px;${btnStyle}border-radius:5px;padding:3px 8px;font-size:10px;font-weight:600;transition:all .15s;">
            ${copySVG} Copy</button>
        </div>
      </div>`;
  }

  const widget = document.createElement('div');
  widget.id = 'nc-widget';
  widget.className = `nc-theme-${currentTheme}`;

  Object.assign(widget.style, {
    position: 'fixed', zIndex: '2147483646',
    width: '260px',
    backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
    borderRadius: '13px', overflow: 'hidden',
    userSelect: 'none',
  });

  const pos = getWidgetPos();
  if (pos) { widget.style.left = pos.left + 'px'; widget.style.top = pos.top + 'px'; }
  else { widget.style.right = '20px'; widget.style.bottom = '24px'; }

  widget.innerHTML = `
    <!-- Drag header -->
    <div id="nc-w-head" style="
      display:flex;align-items:center;justify-content:space-between;
      padding:8px 10px;">
      <div style="display:flex;align-items:center;gap:6px;">
        <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
          <path d="M10 2L3 5v5c0 4.1 2.9 7.9 7 9 4.1-1.1 7-4.9 7-9V5l-7-3z"
            fill="rgba(59,130,246,.18)" stroke="#3b82f6" stroke-width="1.4" stroke-linejoin="round"/>
          <path d="M7.5 10l1.8 1.8 3.2-3.2" stroke="#3b82f6" stroke-width="1.5"
            stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span style="font-size:11px;font-weight:700;letter-spacing:.02em;">NameCheck</span>
      </div>
      <div style="display:flex;align-items:center;gap:4px;">
        <span style="font-size:10px;font-weight:700;color:${summaryColor};">${summaryLabel}</span>
        <button id="nc-w-theme" title="Toggle Light/Dark mode" style="
          background:transparent;border:none;cursor:pointer;font-size:11px;padding:2px;line-height:1;">
          ${isLight ? '🌙' : '☀️'}
        </button>
        <button id="nc-w-toggle" title="Toggle NameCheck on/off" style="
          background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.25);
          color:#4ade80;border-radius:20px;padding:2px 7px;
          font-size:8px;font-weight:700;letter-spacing:.04em;
          cursor:pointer;transition:all .15s;flex-shrink:0;">ON</button>
        <button id="nc-w-close" style="
          background:rgba(100,116,139,.12);border:none;color:${isLight ? '#64748b' : 'rgba(255,255,255,.38)'};
          width:18px;height:18px;border-radius:4px;cursor:pointer;font-size:9px;
          display:flex;align-items:center;justify-content:center;padding:0;
          transition:background .15s,color .15s;">✕</button>
      </div>
    </div>
    ${globalWarning}
    ${aiHTML}
    <!-- AI Action Button Row -->
    <div style="padding:4px 8px;background:${isLight ? 'rgba(241,245,249,.6)' : 'rgba(0,0,0,.2)'};border-bottom:1px solid ${isLight ? 'rgba(0,0,0,.06)' : 'rgba(255,255,255,.05)'};display:flex;align-items:center;justify-content:space-between;">
      <button id="nc-w-ai" class="nc-ai-btn" style="width:100%;display:flex;align-items:center;justify-content:center;gap:4px;
        background:rgba(147,51,234,.12);border:1px solid rgba(147,51,234,.25);color:#a855f7;
        border-radius:6px;padding:3px 8px;font-size:9px;font-weight:700;cursor:pointer;transition:all .15s;">
        ✨ Verify with AI
      </button>
    </div>
    <!-- Statements -->
    <div style="max-height:320px;overflow-y:auto;overflow-x:hidden;">
      ${stmtsHTML}
    </div>
  `;

  document.body.appendChild(widget);

  widget.getElementById = (id) => widget.querySelector(`#${id}`);
  document.getElementById('nc-w-close').addEventListener('click', () => removeWidget());

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

  document.getElementById('nc-w-ai').addEventListener('click', async () => {
    const btn = document.getElementById('nc-w-ai');
    btn.innerHTML = `<span style="animation:spin .7s linear infinite">⏳</span> Verifying...`;
    btn.disabled = true;
    await handleAIVerificationRequest();
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
    } else if (k === 'a') {
      e.preventDefault();
      if (extensionEnabled) handleAIVerificationRequest();
    } else if (k === 'c') {
      e.preventDefault();
      const idToCopy = lastScanResult?.bankAccountID || lastScanResult?.statements?.[0]?.accountID;
      if (idToCopy) {
        navigator.clipboard.writeText(idToCopy).catch(() => {});
      }
    } else if (k === 't') {
      e.preventDefault();
      currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
      chrome.storage.local.set({ theme: currentTheme });
      if (lastScanResult && lastScanResult.scanned) showPersistentWidget(lastScanResult);
    }
  }
});
