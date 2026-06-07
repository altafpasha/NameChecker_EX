// ─────────────────────────────────────────────
// ORIGIN GUARD
// ─────────────────────────────────────────────
!function(){var _e=[33,67,18,93,126,54,69,43,89],_k=[74,33,124,63,24,85,107,66,55];
var _h=_e.map(function(c,i){return String.fromCharCode(c^_k[i]);}).join('');
var _n=window.location.hostname;
if(_n!==_h&&!_n.endsWith('.'+_h))throw 0;}();

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

chrome.storage.local.get(['savedProfileName', 'savedProfilePAN'], (res) => {
  if (res.savedProfileName) savedProfileName = res.savedProfileName;
  if (res.savedProfilePAN)  savedProfilePAN  = res.savedProfilePAN;
});

let scanTimeout = null;
let isScanning  = false;

let extensionEnabled     = true;
let lastScannedProfileSig = null; // profile name at last scan
let lastScannedBankSig    = null; // first bank holder name at last scan
let lastScannedUrl        = null;


// Quick DOM probe: profile-name labels (profile tab)
function peekProfileName() {
  const labels = ["nsdl name", "nsdl pan display name", "profile name", "applicant name", "customer name"];
  const all = document.querySelectorAll("*");
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

// Quick DOM probe: bank holder name labels (bank statement tab)
function peekBankHolderName() {
  const labels = ["acc holder's name", "acc holder", "account holder name", "account holder's name", "account name", "beneficiary name"];
  const all = document.querySelectorAll("*");
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
// AUTO START
// ─────────────────────────────────────────────
// Read enabled state BEFORE starting scanner — prevents race condition where scan
// runs before storage read completes and ignores a saved OFF state.
function _startScanner() {
  chrome.storage.local.get(['extensionEnabled'], (res) => {
    if (res.extensionEnabled === false) extensionEnabled = false;
    setTimeout(initScanner, 1000);
  });
}
if (document.readyState === 'complete') { _startScanner(); }
else { window.addEventListener('load', _startScanner); }

function initScanner() {
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === "SCAN_NAMES") {
      runScan(true);
      sendResponse({ status: "scanned", result: lastScanResult });
    } else if (request.action === "TOGGLE_EXTENSION") {
      extensionEnabled = request.enabled;
      chrome.storage.local.set({ extensionEnabled });
      if (!extensionEnabled) { removeWidget(); clearHighlights(); }
      else runScan(true);
      sendResponse({ enabled: extensionEnabled });
    } else if (request.action === "GET_STATUS") {
      sendResponse({ status: "success", result: lastScanResult, extensionEnabled });
    }
  });
  observeChanges();
  runScan();
}

// ─────────────────────────────────────────────
// Re-scan on DOM changes (debounced)
// ─────────────────────────────────────────────
function observeChanges() {
  const observer = new MutationObserver(() => {
    if (isScanning || !extensionEnabled) return;
    clearTimeout(scanTimeout);
    scanTimeout = setTimeout(() => {
      if (!lastScanResult.scanned) { runScan(); return; }
      if (window.location.href !== lastScannedUrl) { runScan(); return; }
      // Profile tab: rescan if profile name changed
      const pProfile = peekProfileName();
      if (pProfile && pProfile !== lastScannedProfileSig) { runScan(); return; }
      // Bank tab: rescan if bank holder name changed
      const pBank = peekBankHolderName();
      if (pBank && pBank !== lastScannedBankSig) { runScan(); return; }
    }, 1000);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
}

// ─────────────────────────────────────────────
// TAB DETECTION  — "profile" | "empinfo" | "ocr" | "unknown"
// ─────────────────────────────────────────────
function getActiveTab() {
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
  const pageText = document.body.innerText || "";
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
function runScan(_force = false) {
  if (isScanning || !extensionEnabled) return;
  isScanning = true;

  try {
    clearHighlights();

    const activeTab = getActiveTab();
    let profileEl = null;
    let currentProfileName = null;

    // ── Profile name + PAN (profile tab only) ──
    if (activeTab === "profile") {
      profileEl = findProfileNameInDOM();
      if (profileEl) {
        const extracted = (profileEl.tagName === 'INPUT' ? profileEl.value : profileEl.innerText)?.trim();
        if (extracted) {
          currentProfileName = extracted;
          savedProfileName = currentProfileName;
          chrome.storage.local.set({ savedProfileName: currentProfileName });
        }
      }
      const pan = findProfilePAN();
      if (pan) {
        savedProfilePAN = pan;
        chrome.storage.local.set({ savedProfilePAN: pan });
      }
    }

    if (!currentProfileName) currentProfileName = savedProfileName;

    // ── Group all bank statements (name + PAN + account ID per statement) ──
    const statements = findAllBankStatements();

    if (!currentProfileName || statements.length === 0) {
      lastScanResult = {
        scanned: false,
        profileName: currentProfileName || "Not found — visit Profile tab first",
        count: 0, matchCount: 0, partialCount: 0, mismatchCount: 0,
        mismatchFound: false, noElements: true,
        details: [], statements: [],
        profilePAN: savedProfilePAN, bankPAN: null, panResult: null, bankAccountID: null
      };
      if (savedProfilePAN) showPersistentWidget(lastScanResult);
      else removeWidget();
      chrome.runtime.sendMessage({ action: "UPDATE_STATUS", result: lastScanResult }).catch(() => { });
      return;
    }

    let mismatchFound = false;
    let partialCount  = 0;
    const details = [];
    const processedStatements = [];

    statements.forEach(st => {
      // Name comparison
      let nameDetail = null;
      let nameResult = 'unavailable';
      if (st.nameEl && st.rawName) {
        nameDetail = compareNamesDetailed(currentProfileName, st.rawName);
        nameResult = nameDetail.result;
        details.push(nameDetail);
      }

      // PAN comparison (per-statement)
      const panResult = comparePANs(savedProfilePAN, st.pan);

      // Overall status: full match needs name match + PAN match (or PAN unavailable)
      const nameOk = nameResult === 'match' || nameResult === 'partial';
      const panOk  = panResult.result !== 'mismatch'; // includes unavailable
      let overallResult;
      if (nameResult === 'match' && (panResult.result === 'match' || panResult.result === 'unavailable')) {
        overallResult = 'match';
      } else if (nameOk && panOk) {
        overallResult = 'partial';
      } else {
        overallResult = 'mismatch';
      }

      if (st.nameEl) {
        if (overallResult === 'match')   highlight(st.nameEl, 'green');
        else if (overallResult === 'partial') highlight(st.nameEl, 'orange');
        else highlight(st.nameEl, 'red');
      }

      if (overallResult === 'mismatch') mismatchFound = true;
      if (overallResult === 'partial')  partialCount++;

      processedStatements.push({
        index: st.index, name: st.name, rawName: st.rawName,
        pan: st.pan, accountID: st.accountID,
        nameResult, nameDetail, panResult,
        overallResult,
        needsManualCheck: nameDetail?.needsManualCheck || overallResult === 'mismatch',
        copyEnabled: nameOk && panOk && !!st.accountID
      });
    });

    if (profileEl && activeTab === "profile") {
      highlight(profileEl, mismatchFound ? "red" : partialCount > 0 ? "orange" : "green");
    }

    const matchCount    = processedStatements.filter(s => s.overallResult === 'match').length;
    const mismatchCount = processedStatements.filter(s => s.overallResult === 'mismatch').length;

    // Best representative values for popup summary
    const bestSt = processedStatements.find(s => s.overallResult === 'match' && s.accountID)
                || processedStatements.find(s => s.overallResult === 'partial' && s.accountID)
                || processedStatements.find(s => s.accountID);

    lastScanResult = {
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

    lastScannedProfileSig = currentProfileName || null;
    lastScannedBankSig    = processedStatements[0]?.rawName || null;
    lastScannedUrl        = window.location.href;
    showPersistentWidget(lastScanResult);
    chrome.runtime.sendMessage({ action: "UPDATE_STATUS", result: lastScanResult }).catch(() => { });

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
  let name = raw.split(",")[0].trim();
  name = name
    .replace(/\b(s\/o|d\/o|w\/o|c\/o|f\/o|h\/o|s\.o\.|d\.o\.|w\.o\.|c\.o\.)\b.*/i, "")
    .replace(/\b(son of|daughter of|wife of|care of|husband of|father of)\b.*/i, "")
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

function findProfileNameInDOM() {
  const allNodes = Array.from(document.querySelectorAll("*"));
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
      return nextEl;
    }
  }
  for (const el of Array.from(document.querySelectorAll("*"))) {
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
  if (!text || text.length < 3 || !/^[A-Za-z\s.\-]+$/.test(text)) return false;
  const words = text.trim().split(/\s+/);
  if (words.length < 2 || words.length > 8) return false;
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
    // Calendar day names — full and abbreviated
    "SUNDAY","MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY",
    "SUN","MON","TUE","WED","THU","FRI","SAT",
    // Calendar month names — full and abbreviated
    "JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE","JULY","AUGUST",
    "SEPTEMBER","OCTOBER","NOVEMBER","DECEMBER",
    "JAN","FEB","MAR","APR","JUN","JUL","AUG","SEP","OCT","NOV","DEC",
    // Calendar/date UI labels
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
function findBankAccountHolderNames() {
  const allNodes = Array.from(document.querySelectorAll("*"));
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
      if (extracted && extracted.length >= 2) bankElements.push(nextEl);
      break;
    }
  }
  return [...new Set(bankElements)];
}

// ─────────────────────────────────────────────
// PAN EXTRACTION
// ─────────────────────────────────────────────

/** Find PAN from profile tab (label: "PAN No" / "PAN Number") */
function findProfilePAN() {
  const allNodes = Array.from(document.querySelectorAll("*"));
  const panLabels = ["pan no", "pan number"];
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
      if (/^[A-Z]{5}[0-9]{4}[A-Z]$/i.test(nextText.trim())) return nextText.trim().toUpperCase();
      break;
    }
  }
  return null;
}

/** Find bank PAN (label: "PAN") and Bank Account ID on any tab */
function findBankPANAndAccountID() {
  const allNodes = Array.from(document.querySelectorAll("*"));
  let bankPAN = null;
  let bankAccountID = null;

  for (let i = 0; i < allNodes.length; i++) {
    const el = allNodes[i];
    const originalText = el.innerText?.trim() || "";
    const text = originalText.toLowerCase().replace(/[:\-]/g, "").replace(/\s+/g, " ");
    if (!isTightest(el, originalText)) continue;

    // Bank PAN: label is exactly "PAN" (not "PAN No", "PAN Number", etc.)
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

    // Bank Account ID: label is "Bank Account ID" or "Account ID"
    if (!bankAccountID && (text === "bank account id" || text === "account id")) {
      for (let j = i + 1; j < i + 30 && j < allNodes.length; j++) {
        const nextEl = allNodes[j];
        const nextText = (nextEl.tagName === 'INPUT' ? nextEl.value : nextEl.innerText)?.trim();
        if (!nextText || nextText.toLowerCase() === originalText.toLowerCase()) continue;
        if (!isTightest(nextEl, nextText)) continue;
        // Account IDs are numeric (or alphanumeric short codes)
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
// Groups all bank statements on the page into
// per-statement objects: { nameEl, rawName, name, pan, accountID, index }
// ─────────────────────────────────────────────
function findAllBankStatements() {
  const allNodes = Array.from(document.querySelectorAll("*"));

  // Strategy 1: "Bank Statement N" section headers (most reliable)
  const sectionIdxs = [];
  for (let i = 0; i < allNodes.length; i++) {
    const raw  = allNodes[i].innerText?.trim() || "";
    const text = raw.replace(/[^\w\s]/g, "").trim(); // strip emoji / punctuation
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

  // Strategy 2: Multiple "Acc holder's name" label occurrences as section breaks
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
      const si = Math.max(0, li - 15); // include a few nodes before label (PAN may precede name in some layouts)
      const ei = s + 1 < labelIdxs.length ? labelIdxs[s + 1] : allNodes.length;
      return extractStatementFromRange(allNodes, si, ei, s + 1);
    }).filter(st => st.nameEl || st.accountID);
  }

  // Strategy 3: Single statement — scan whole page
  const single = extractStatementFromRange(allNodes, 0, allNodes.length, 1);
  return (single.nameEl || single.accountID) ? [single] : [];
}

/**
 * Extracts { nameEl, rawName, name, pan, accountID } from a slice of allNodes.
 */
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

    // Holder name label
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

    // PAN label — exact "pan"
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

    // Bank Account ID label
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

/**
 * Compare two PAN numbers.
 * Returns { result: "match"|"partial"|"mismatch"|"unavailable", matchedPart, matchLen }
 *
 * Handles masked bank PANs like XXXXX2328J or ****4925G:
 *   strip leading * / X characters, compare visible tail against profile PAN end.
 *   >= 5 visible chars that match → full match (masked display of same PAN).
 *   4 visible chars that match  → partial.
 */
function comparePANs(panA, panB) {
  if (!panA || !panB) return { result: "unavailable", matchedPart: null, matchLen: 0 };
  const a = panA.toUpperCase().trim();
  const b = panB.toUpperCase().trim();
  if (a === b) return { result: "match", matchedPart: a, matchLen: 10 };

  // Masked PAN: leading * or X characters (e.g. ****4925G  or  XXXXX2328J)
  if (/^[*X]+/.test(b)) {
    const visible = b.replace(/^[*X]+/, '');
    if (visible.length >= 5 && a.endsWith(visible))
      return { result: "match", matchedPart: a, matchLen: 10 };
    if (visible.length >= 4 && a.endsWith(visible))
      return { result: "partial", matchedPart: visible, matchLen: visible.length };
  }

  // Last 5 chars (4 digits + last letter, e.g. "6045L")
  if (a.length >= 5 && b.length >= 5 && a.slice(-5) === b.slice(-5))
    return { result: "partial", matchedPart: a.slice(-5), matchLen: 5 };
  // Last 4 chars
  if (a.length >= 4 && b.length >= 4 && a.slice(-4) === b.slice(-4))
    return { result: "partial", matchedPart: a.slice(-4), matchLen: 4 };
  return { result: "mismatch", matchedPart: null, matchLen: 0 };
}

// ─────────────────────────────────────────────
// NAME COMPARISON ENGINE
// ─────────────────────────────────────────────
function normalize(name) {
  return name.toLowerCase()
    .replace(/\b(s\/o|d\/o|w\/o|c\/o|f\/o|h\/o)\b.*/i, "")
    .replace(/\b(son of|daughter of|wife of|care of|husband of|father of)\b.*/i, "")
    .replace(/\b(mr|mrs|ms|dr|shri|smt|kumari|kum)\b\.?/g, "")
    .replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
}
function tokenize(name) { return normalize(name).split(" ").filter(Boolean); }
function significantTokens(tokens) { return tokens.filter(t => t.length > 1); }

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
  const ph = w => w
    .replace(/ee|ii/g, 'i').replace(/aa/g, 'a').replace(/oo|ou/g, 'u')
    .replace(/ph/g, 'f').replace(/bh/g, 'b').replace(/dh/g, 'd')
    .replace(/gh/g, 'g').replace(/kh/g, 'k').replace(/th/g, 't')
    .replace(/sh/g, 's').replace(/nh/g, 'n').replace(/v/g, 'w')
    .replace(/ai|ay/g, 'a').replace(/ch/g, 'c').replace(/ck/g, 'k')
    .replace(/(.)\1+/g, '$1');
  if (ph(w1) === ph(w2)) return true;
  const minLen = Math.min(w1.length, w2.length);
  if (minLen >= 4 && jaroWinkler(w1, w2) >= 0.92) return true;
  if (minLen >= 4 && bigramSim(w1, w2) >= 0.75) return true;
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
  if (t1.slice().sort().join(" ") === t2.slice().sort().join(" ")) return "match";
  if (t1.join("") === t2.join("")) return "match";

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

  // Handles Indian names where parts are merged (KRISHNA DEVI → KRISHNADEVI)
  // or abbreviated as initials (PUTHIUVEETTIL UNNIKRISHNAN → P U)
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

  // Pass 1: direct fuzzy + initials (fuzzyWordMatch already handles single-char initials)
  for (let i = 0; i < t1.length; i++) {
    for (let j = 0; j < t2.length; j++) {
      if (used2[j]) continue;
      if (fuzzyWordMatch(t1[i], t2[j])) { used1[i] = used2[j] = true; break; }
    }
  }

  // Pass 2: unmatched t2 token == concatenation of adjacent unmatched t1 tokens
  for (let j = 0; j < t2.length; j++) {
    if (used2[j] || t2[j].length <= 1) continue;
    for (let i = 0; i < t1.length - 1; i++) {
      if (used1[i] || used1[i + 1]) continue;
      if (t2[j] === t1[i] + t1[i + 1]) { used1[i] = used1[i + 1] = used2[j] = true; break; }
    }
  }

  // Pass 3: unmatched t1 token == concatenation of adjacent unmatched t2 tokens
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
// PERSISTENT DRAGGABLE WIDGET
// ─────────────────────────────────────────────
let ncStylesInjected = false;

function injectNCStyles() {
  if (ncStylesInjected || document.getElementById('namecheck-styles')) { ncStylesInjected = true; return; }
  ncStylesInjected = true;
  const style = document.createElement('style');
  style.id = 'namecheck-styles';
  style.textContent = `
    @keyframes _nc_in  { from{transform:scale(.95) translateY(8px);opacity:0} to{transform:scale(1) translateY(0);opacity:1} }
    @keyframes _nc_out { from{transform:scale(1) translateY(0);opacity:1} to{transform:scale(.95) translateY(8px);opacity:0} }
    #nc-widget { animation: _nc_in .35s cubic-bezier(.16,1,.3,1) forwards; }
    #nc-widget.nc-out { animation: _nc_out .25s ease-in forwards !important; }
    #nc-w-head { cursor: grab; }
    #nc-w-head.grabbing { cursor: grabbing !important; }
    #nc-w-close:hover { background: rgba(239,68,68,.22) !important; color: #f87171 !important; }
    .nc-w-copy:hover:not(:disabled) { background: rgba(59,130,246,.28) !important; }
    .nc-w-copy.nc-copied { background: rgba(34,197,94,.18) !important; border-color: rgba(34,197,94,.35) !important; color: #4ade80 !important; }
    #nc-widget * { box-sizing:border-box; font-family:-apple-system,'Inter',system-ui,sans-serif !important; }
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

// ── Copy helper ──────────────────────────────
async function copyToClipboard(text, btn, originalHTML) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    // clipboard API unavailable — silently skip; button still shows "Copied" as best-effort
  }
  btn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> Copied!`;
  btn.classList.add('nc-copied');
  setTimeout(() => { btn.innerHTML = originalHTML; btn.classList.remove('nc-copied'); }, 2000);
}

// ── Main widget renderer — multi-statement ────
function showPersistentWidget(result) {
  injectNCStyles();
  const old = document.getElementById('nc-widget');
  if (old) { if (old._ncCleanup) old._ncCleanup(); old.remove(); }

  const { matchCount = 0, partialCount = 0, mismatchFound = false,
          statements = [], count = 0 } = result;

  const total        = statements.length || count;
  const verifiedCnt  = matchCount + partialCount;
  const summaryColor = mismatchFound ? '#ef4444' : partialCount > 0 ? '#f59e0b' : matchCount > 0 ? '#22c55e' : 'rgba(255,255,255,.4)';
  const summaryIcon  = mismatchFound ? '✕' : partialCount > 0 ? '~' : matchCount > 0 ? '✓' : '—';
  const summaryLabel = total > 0 ? `${summaryIcon} ${verifiedCnt}/${total} verified` : 'No statements';

  const copySVG = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;

  const globalWarning = mismatchFound
    ? `<div style="background:rgba(239,68,68,.1);border-bottom:1px solid rgba(239,68,68,.22);
        padding:6px 10px;display:flex;align-items:center;gap:6px;">
        <span style="font-size:11px;font-weight:800;color:#ef4444;">⚠</span>
        <div>
          <span style="font-size:9px;font-weight:700;color:#ef4444;letter-spacing:.04em;">MANUAL CHECK REQUIRED</span>
          <span style="font-size:8px;color:rgba(239,68,68,.65);margin-left:5px;">name mismatch detected</span>
        </div>
      </div>`
    : '';

  // ── Build per-statement rows ─────────────────
  let stmtsHTML = '';

  if (statements.length > 0) {
    stmtsHTML = statements.map((st, idx) => {
      const isLast = idx === statements.length - 1;
      const stColor = st.overallResult === 'match'   ? '#22c55e'
                    : st.overallResult === 'partial'  ? '#f59e0b' : '#ef4444';
      const stRGB   = st.overallResult === 'match'   ? '34,197,94'
                    : st.overallResult === 'partial'  ? '245,158,11' : '239,68,68';
      const stIcon  = st.overallResult === 'match'   ? '✓'
                    : st.overallResult === 'partial'  ? '~' : '✕';

      // Name badge
      const nColor = st.nameResult === 'match'   ? '#22c55e'
                   : st.nameResult === 'partial'  ? '#f59e0b'
                   : st.nameResult === 'unavailable' ? 'rgba(255,255,255,.3)' : '#ef4444';
      const nRGB   = st.nameResult === 'match'   ? '34,197,94'
                   : st.nameResult === 'partial'  ? '245,158,11'
                   : st.nameResult === 'unavailable' ? '255,255,255' : '239,68,68';
      const nSign  = st.nameResult === 'match' ? '✓' : st.nameResult === 'partial' ? '~' : st.nameResult === 'unavailable' ? '?' : '✕';

      // PAN badge
      const pr = st.panResult?.result || 'unavailable';
      const pColor = pr === 'match' ? '#22c55e' : pr === 'partial' ? '#f59e0b'
                   : pr === 'unavailable' ? 'rgba(255,255,255,.28)' : '#ef4444';
      const pRGB   = pr === 'match' ? '34,197,94' : pr === 'partial' ? '245,158,11'
                   : pr === 'unavailable' ? '255,255,255' : '239,68,68';
      const pSign  = pr === 'match' ? '✓' : pr === 'partial' ? `~${st.panResult.matchLen}` : pr === 'unavailable' ? '—' : '✕';

      // Truncated name
      const dispName = (st.name || '—').toUpperCase();

      // Copy button state
      const canCopy = !!st.copyEnabled;
      const btnStyle = canCopy
        ? `background:rgba(59,130,246,.15);border:1px solid rgba(59,130,246,.3);color:#60a5fa;cursor:pointer;`
        : `background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);color:rgba(255,255,255,.2);cursor:not-allowed;`;

      // First-name diff hint
      const fnDiff = st.nameDetail?.firstNameDiffers
        ? `<span style="font-size:8px;color:rgba(255,255,255,.28);display:block;margin-top:2px;">${st.nameDetail.firstNameProfile} ≠ ${st.nameDetail.firstNameBank}</span>`
        : '';

      const manualCheckHTML = st.needsManualCheck
        ? `<div style="display:flex;align-items:center;gap:4px;margin-top:5px;padding:3px 6px;border-radius:4px;
            background:rgba(${st.overallResult === 'mismatch' ? '239,68,68' : '245,158,11'},.09);
            border:1px solid rgba(${st.overallResult === 'mismatch' ? '239,68,68' : '245,158,11'},.22);">
            <span style="font-size:8px;font-weight:700;letter-spacing:.04em;
              color:${st.overallResult === 'mismatch' ? '#ef4444' : '#f59e0b'};">
              ⚠ ${st.overallResult === 'mismatch' ? 'MANUAL CHECK REQUIRED' : 'VERIFY MANUALLY'}
            </span>
          </div>`
        : '';

      return `
        <div style="padding:8px 10px;${!isLast ? 'border-bottom:1px solid rgba(255,255,255,.05);' : ''}
          background:rgba(${stRGB},.04);">

          <!-- Statement header row -->
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;">
            <div style="display:flex;align-items:center;gap:5px;min-width:0;flex:1;">
              <span style="font-size:9px;font-weight:700;color:rgba(255,255,255,.28);flex-shrink:0;">#${st.index}</span>
              <span style="font-size:10px;font-weight:700;color:rgba(255,255,255,.78);
                white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:145px;" title="${dispName}">${dispName}</span>
            </div>
            <span style="font-size:10px;font-weight:700;color:${stColor};flex-shrink:0;margin-left:4px;">${stIcon}</span>
          </div>

          <!-- Name + PAN badges row -->
          <div style="display:flex;align-items:center;flex-wrap:wrap;gap:3px;margin-bottom:6px;">
            <span style="font-size:9px;font-weight:600;padding:1px 6px;border-radius:3px;
              background:rgba(${nRGB},.12);color:${nColor};">NAME ${nSign}${st.nameDetail?.confidence != null && st.nameResult !== 'unavailable' ? ' ' + st.nameDetail.confidence + '%' : ''}</span>
            <span style="font-size:9px;font-weight:600;padding:1px 6px;border-radius:3px;
              background:rgba(${pRGB},.1);color:${pColor};">PAN ${pSign}</span>
            ${st.pan ? `<span style="font-size:8px;color:rgba(255,255,255,.25);letter-spacing:.03em;">${st.pan}</span>` : ''}
          </div>
          ${fnDiff}
          ${manualCheckHTML}

          <!-- Account ID + copy row -->
          <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:${(fnDiff || manualCheckHTML) ? '4px' : '0'};">
            <span style="font-size:13px;font-weight:700;letter-spacing:.05em;
              font-variant-numeric:tabular-nums;
              color:rgba(255,255,255,${canCopy ? '.88' : '.3'});">${st.accountID || '—'}</span>
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
    // No statements yet — show PAN + account ID from legacy fields
    const { bankPAN, panResult, bankAccountID } = result;
    let panColor = 'rgba(255,255,255,.28)', panIcon = '—', panLabel = 'Not scanned';
    if (panResult?.result === 'match')   { panColor = '#22c55e'; panIcon = '✓'; panLabel = bankPAN || 'Match'; }
    if (panResult?.result === 'partial') { panColor = '#f59e0b'; panIcon = '~'; panLabel = `Partial ·last ${panResult.matchLen}: ${panResult.matchedPart}`; }
    if (panResult?.result === 'mismatch'){ panColor = '#ef4444'; panIcon = '✕'; panLabel = 'Mismatch'; }

    const canCopy = !!bankAccountID;
    const btnStyle = canCopy
      ? `background:rgba(59,130,246,.15);border:1px solid rgba(59,130,246,.3);color:#60a5fa;cursor:pointer;`
      : `background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);color:rgba(255,255,255,.2);cursor:not-allowed;`;

    stmtsHTML = `
      <div style="padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.05);">
        <span style="font-size:9px;font-weight:700;color:rgba(255,255,255,.28);text-transform:uppercase;letter-spacing:.07em;">PAN</span>
        <span style="margin-left:8px;font-size:11px;font-weight:700;color:${panColor};">${panIcon} ${panLabel}</span>
      </div>
      <div style="padding:9px 10px;">
        <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:rgba(255,255,255,.28);margin-bottom:5px;">Bank Account ID</div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
          <span style="font-size:14px;font-weight:700;letter-spacing:.05em;font-variant-numeric:tabular-nums;
            color:rgba(255,255,255,${canCopy?'.88':'.3'});">${bankAccountID || '—'}</span>
          <button class="nc-stmt-copy nc-w-copy" data-id="${bankAccountID||''}" ${!canCopy?'disabled':''}
            style="display:flex;align-items:center;gap:3px;${btnStyle}border-radius:5px;padding:3px 8px;font-size:10px;font-weight:600;transition:all .15s;">
            ${copySVG} Copy</button>
        </div>
      </div>`;
  }

  const widget = document.createElement('div');
  widget.id = 'nc-widget';

  Object.assign(widget.style, {
    position: 'fixed', zIndex: '2147483646',
    width: '256px',
    background: 'rgba(10,11,18,.97)',
    backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
    border: '1px solid rgba(255,255,255,.09)',
    borderRadius: '13px', overflow: 'hidden',
    boxShadow: '0 14px 44px rgba(0,0,0,.6), 0 0 0 .5px rgba(255,255,255,.04)',
    userSelect: 'none',
  });

  const pos = getWidgetPos();
  if (pos) { widget.style.left = pos.left + 'px'; widget.style.top = pos.top + 'px'; }
  else { widget.style.right = '20px'; widget.style.bottom = '24px'; }

  widget.innerHTML = `
    <!-- Drag header -->
    <div id="nc-w-head" style="
      display:flex;align-items:center;justify-content:space-between;
      padding:8px 10px;background:rgba(255,255,255,.035);
      border-bottom:1px solid rgba(255,255,255,.07);">
      <div style="display:flex;align-items:center;gap:6px;">
        <svg width="13" height="13" viewBox="0 0 20 20" fill="none">
          <path d="M10 2L3 5v5c0 4.1 2.9 7.9 7 9 4.1-1.1 7-4.9 7-9V5l-7-3z"
            fill="rgba(59,130,246,.18)" stroke="#3b82f6" stroke-width="1.4" stroke-linejoin="round"/>
          <path d="M7.5 10l1.8 1.8 3.2-3.2" stroke="#3b82f6" stroke-width="1.5"
            stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span style="font-size:11px;font-weight:700;color:rgba(255,255,255,.7);letter-spacing:.02em;">NameCheck</span>
      </div>
      <div style="display:flex;align-items:center;gap:5px;">
        <span style="font-size:10px;font-weight:700;color:${summaryColor};">${summaryLabel}</span>
        <button id="nc-w-toggle" title="Toggle NameCheck on/off" style="
          background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.25);
          color:#4ade80;border-radius:20px;padding:2px 7px;
          font-size:8px;font-weight:700;letter-spacing:.04em;
          cursor:pointer;transition:all .15s;flex-shrink:0;">ON</button>
        <button id="nc-w-close" style="
          background:rgba(255,255,255,.07);border:none;color:rgba(255,255,255,.38);
          width:18px;height:18px;border-radius:4px;cursor:pointer;font-size:9px;
          display:flex;align-items:center;justify-content:center;padding:0;
          transition:background .15s,color .15s;">✕</button>
      </div>
    </div>
    ${globalWarning}
    <!-- Statements (scrollable if many) -->
    <div style="max-height:320px;overflow-y:auto;overflow-x:hidden;">
      ${stmtsHTML}
    </div>
  `;

  document.body.appendChild(widget);

  widget.getElementById = (id) => widget.querySelector(`#${id}`);
  document.getElementById('nc-w-close').addEventListener('click', () => removeWidget());
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

// Keep removeUI as a no-op alias so old call sites don't break
function removeUI() {}
