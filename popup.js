document.addEventListener("DOMContentLoaded", async () => {
  const scanBtn          = document.getElementById("scanBtn");
  const resetBtn         = document.getElementById("resetBtn");
  const themeBtn         = document.getElementById("themeBtn");
  const settingsBtn      = document.getElementById("settingsBtn");
  const settingsModal    = document.getElementById("settingsModal");
  const closeModalBtn    = document.getElementById("closeModalBtn");
  const saveKeyBtn       = document.getElementById("saveKeyBtn");
  const clearKeyBtn      = document.getElementById("clearKeyBtn");

  const monitoringStatus = document.getElementById("monitoring-status");
  const statusText       = document.getElementById("status-text");
  const valProfile       = document.getElementById("val-profile");
  const valCount         = document.getElementById("val-count");
  const valMatch         = document.getElementById("val-match");
  const valPartial       = document.getElementById("val-partial");
  const valMismatch      = document.getElementById("val-mismatch");
  const resultBox        = document.getElementById("result-box");
  const resultIcon       = document.getElementById("result-icon");
  const resultText       = document.getElementById("result-text");
  const resultSub        = document.getElementById("result-sub");
  const partialPanel     = document.getElementById("partial-panel");
  const fnProfile        = document.getElementById("fn-profile");
  const fnBank           = document.getElementById("fn-bank");

  const valProfilePAN    = document.getElementById("val-profile-pan");
  const valBankPAN       = document.getElementById("val-bank-pan");
  const panBadge         = document.getElementById("pan-badge");
  const panPartialInfo   = document.getElementById("pan-partial-info");
  const panMatchLen      = document.getElementById("pan-match-len");
  const panMatchPart     = document.getElementById("pan-match-part");
  const acctIdsList      = document.getElementById("acct-ids-list");
  const valAcctType      = document.getElementById("val-acct-type");
  const acctBadge        = document.getElementById("acct-badge");
  const acctAlertInfo    = document.getElementById("acct-alert-info");
  const overallBadge     = document.getElementById("overall-badge");
  const overallInfo      = document.getElementById("overall-info");

  const valAppId         = document.getElementById("val-app-id");
  const needleToggle     = document.getElementById("needleToggle");
  const engineModeStandard = document.getElementById("engineModeStandard");
  const engineModeEnhanced = document.getElementById("engineModeEnhanced");
  const needleStatusBadge  = document.getElementById("needleStatusBadge");

  const aiBtn          = document.getElementById("aiBtn");
  const aiBox          = document.getElementById("ai-box");
  const aiVerdict      = document.getElementById("ai-verdict");
  const aiReason       = document.getElementById("ai-reason");
  const providerSelect = document.getElementById("providerSelect");
  const apiKeyInput    = document.getElementById("apiKeyInput");
  const apiKeyRow      = document.getElementById("apiKeyRow");

  const contentContainer = document.getElementById("content-container");
  const enableToggle     = document.getElementById("enable-toggle");

  const copySVG = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
  const checkSVG = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

  function icon(id, size, extraClass) {
    return `<svg class="icon ${extraClass || ''}" width="${size}" height="${size}" viewBox="0 0 24 24"><use href="#${id}"/></svg>`;
  }
  function setResultIcon(id, colorVar, spinning) {
    resultIcon.innerHTML = icon(id, 16, spinning ? 'icon-spin' : '');
    resultIcon.style.color = `var(${colorVar})`;
  }

  let currentTheme = 'dark';

  monitoringStatus.style.cursor = "pointer";
  monitoringStatus.title = "Click to auto-reconnect scanner to dashboard";
  monitoringStatus.addEventListener("click", () => {
    autoInjectAndConnect();
  });

  function applyTheme(theme) {
    currentTheme = theme || 'dark';
    document.documentElement.setAttribute('data-theme', currentTheme);
    themeBtn.innerHTML = icon(currentTheme === 'light' ? 'ic-moon' : 'ic-sun', 14);
  }

  const allowedDomainsInput       = document.getElementById("allowedDomainsInput");
  const toggleDomainVisibilityBtn = document.getElementById("toggleDomainVisibilityBtn");

  if (toggleDomainVisibilityBtn) {
    toggleDomainVisibilityBtn.addEventListener("click", () => {
      if (allowedDomainsInput.type === "password") {
        allowedDomainsInput.type = "text";
        toggleDomainVisibilityBtn.innerHTML = icon('ic-eye-off', 14);
      } else {
        allowedDomainsInput.type = "password";
        toggleDomainVisibilityBtn.innerHTML = icon('ic-eye', 14);
      }
    });
  }

  const grabCurrentTabBtn = document.getElementById("grabCurrentTabBtn");
  if (grabCurrentTabBtn) {
    grabCurrentTabBtn.addEventListener("click", () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs[0] && tabs[0].url) {
          try {
            const u = new URL(tabs[0].url);
            if (u.protocol.startsWith("http")) {
              const host = u.hostname;
              const cur = allowedDomainsInput.value.trim();
              if (!cur || cur === "*") {
                allowedDomainsInput.value = host;
              } else if (!cur.includes(host)) {
                allowedDomainsInput.value = cur + ", " + host;
              }
              grabCurrentTabBtn.style.color = "var(--success)";
              setTimeout(() => { grabCurrentTabBtn.style.color = "inherit"; }, 1000);
            }
          } catch (_) {}
        }
      });
    });
  }

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

  function updateNeedleToggleUI(enabled) {
    if (!needleToggle) return;
    needleToggle.className = `toggle-pill ${enabled ? "on" : "off"}`;
    needleToggle.innerText = enabled ? "ON" : "OFF";
  }

  let isModelDownloaded = false;

  function updateNeedleStatusBadge(enabled, mode) {
    if (!needleStatusBadge) return;
    if (!enabled) {
      needleStatusBadge.className = "pan-badge none";
      needleStatusBadge.innerText = "Disabled";
    } else if (isModelDownloaded) {
      needleStatusBadge.className = "pan-badge match";
      needleStatusBadge.innerText = mode === 'enhanced' ? "Active (Needle 3 Local)" : "Standby (Ready)";
    } else {
      needleStatusBadge.className = "pan-badge partial";
      needleStatusBadge.innerText = mode === 'enhanced' ? "Model Not Downloaded" : "Standby (Offline)";
    }
  }

  if (providerSelect && apiKeyRow) {
    providerSelect.addEventListener("change", () => {
      apiKeyRow.style.display = providerSelect.value === 'gemini' ? 'block' : 'none';
    });
  }

  // Load theme and saved settings
  chrome.storage.local.get(['theme', 'extensionEnabled', 'allowedDomains', 'engineMode', 'needle3Enabled', 'needle3ModelDownloaded', 'geminiApiKey', 'aiProvider'], (res) => {
    isModelDownloaded = res.needle3ModelDownloaded === true;
    applyTheme(res.theme || 'dark');
    updateToggleUI(res.extensionEnabled !== false);
    if (res.allowedDomains) {
      allowedDomainsInput.value = decryptDomainString(res.allowedDomains);
    } else {
      allowedDomainsInput.value = "*";
    }

    if (res.geminiApiKey && apiKeyInput) {
      apiKeyInput.value = decryptApiKey(res.geminiApiKey);
    }
    if (res.aiProvider && providerSelect) {
      providerSelect.value = res.aiProvider;
      if (apiKeyRow) apiKeyRow.style.display = res.aiProvider === 'gemini' ? 'block' : 'none';
    }

    const needleEnabled = res.needle3Enabled === true;
    const mode = res.engineMode === 'enhanced' ? 'enhanced' : 'standard';
    updateNeedleToggleUI(needleEnabled);
    if (engineModeEnhanced && engineModeStandard) {
      if (mode === 'enhanced') engineModeEnhanced.checked = true;
      else engineModeStandard.checked = true;
    }
    updateNeedleStatusBadge(needleEnabled, mode);
  });

  // Real-time synchronization with welcome.html and background storage
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if (changes.needle3ModelDownloaded !== undefined) {
        isModelDownloaded = changes.needle3ModelDownloaded.newValue === true;
      }
      if (changes.needle3Enabled !== undefined) {
        const en = changes.needle3Enabled.newValue === true;
        updateNeedleToggleUI(en);
        const currentMode = (engineModeEnhanced && engineModeEnhanced.checked) ? 'enhanced' : 'standard';
        updateNeedleStatusBadge(en, currentMode);
      }
      if (changes.engineMode !== undefined) {
        const m = changes.engineMode.newValue || 'standard';
        if (m === 'enhanced') {
          if (engineModeEnhanced) engineModeEnhanced.checked = true;
        } else {
          if (engineModeStandard) engineModeStandard.checked = true;
        }
        const isNeedleOn = needleToggle && needleToggle.classList.contains("on");
        updateNeedleStatusBadge(isNeedleOn, m);
      }
      if (changes.allowedDomains !== undefined) {
        const dec = decryptDomainString(changes.allowedDomains.newValue) || "*";
        if (allowedDomainsInput && allowedDomainsInput.value !== dec) {
          allowedDomainsInput.value = dec;
        }
      }
      if (changes.theme !== undefined) {
        applyTheme(changes.theme.newValue);
      }
    }
  });

  if (needleToggle) {
    needleToggle.addEventListener("click", () => {
      const isCurrentlyOn = needleToggle.classList.contains("on");
      const nextState = !isCurrentlyOn;
      updateNeedleToggleUI(nextState);
      const currentMode = engineModeEnhanced && engineModeEnhanced.checked ? 'enhanced' : 'standard';
      updateNeedleStatusBadge(nextState, currentMode);
    });
  }

  if (engineModeStandard) {
    engineModeStandard.addEventListener("change", () => {
      const isNeedleOn = needleToggle && needleToggle.classList.contains("on");
      updateNeedleStatusBadge(isNeedleOn, 'standard');
    });
  }

  if (engineModeEnhanced) {
    engineModeEnhanced.addEventListener("change", () => {
      const isNeedleOn = needleToggle && needleToggle.classList.contains("on");
      updateNeedleStatusBadge(isNeedleOn, 'enhanced');
    });
  }

  themeBtn.addEventListener("click", () => {
    const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
    applyTheme(nextTheme);
    chrome.storage.local.set({ theme: nextTheme });
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, { action: "SET_THEME", theme: nextTheme }, () => {
        if (chrome.runtime.lastError) {}
      });
    }
  });

  settingsBtn.addEventListener("click", () => {
    settingsModal.classList.add("visible");
  });

  closeModalBtn.addEventListener("click", () => {
    settingsModal.classList.remove("visible");
  });

  saveKeyBtn.addEventListener("click", () => {
    const rawDomains = allowedDomainsInput.value.trim();
    const normalizedDomains = rawDomains
      .split(/[\s,\n]+/)
      .map(d => d.trim())
      .filter(Boolean)
      .join(", ") || "*";
    const encDomains = encryptDomainString(normalizedDomains);
    const selectedMode = (engineModeEnhanced && engineModeEnhanced.checked) ? 'enhanced' : 'standard';
    const needleEnabled = needleToggle ? needleToggle.classList.contains("on") : false;
    const encApiKey = encryptApiKey(apiKeyInput ? apiKeyInput.value.trim() : "");
    const selectedProvider = providerSelect ? providerSelect.value : "gemini";

    chrome.storage.local.set({
      allowedDomains: encDomains,
      engineMode: selectedMode,
      needle3Enabled: needleEnabled,
      geminiApiKey: encApiKey,
      aiProvider: selectedProvider
    });

    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, {
        action: "SAVE_SETTINGS",
        allowedDomains: encDomains,
        engineMode: selectedMode,
        needle3Enabled: needleEnabled,
        apiKey: apiKeyInput ? apiKeyInput.value.trim() : "",
        geminiApiKey: encApiKey,
        provider: selectedProvider
      }, () => {
        if (chrome.runtime.lastError) {}
      });
    }

    saveKeyBtn.innerText = "Saved!";
    setTimeout(() => {
      saveKeyBtn.innerText = "Save Settings";
      settingsModal.classList.remove("visible");
    }, 600);
  });

  clearKeyBtn.addEventListener("click", () => {
    allowedDomainsInput.value = "*";
    const encDomains = encryptDomainString("*");
    if (engineModeStandard) engineModeStandard.checked = true;
    updateNeedleToggleUI(false);
    updateNeedleStatusBadge(false, 'standard');

    chrome.storage.local.set({
      allowedDomains: encDomains,
      engineMode: 'standard',
      needle3Enabled: false
    });
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, {
        action: "SAVE_SETTINGS",
        allowedDomains: encDomains,
        engineMode: 'standard',
        needle3Enabled: false
      }, () => {
        if (chrome.runtime.lastError) {}
      });
    }
    clearKeyBtn.innerText = "Reset Done";
    setTimeout(() => { clearKeyBtn.innerText = "Reset (*)"; }, 800);
  });

  const openWelcomeBtn = document.getElementById("openWelcomeBtn");
  if (openWelcomeBtn) {
    openWelcomeBtn.addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
    });
  }

  // Global Shortcut Listener in Popup Window
  document.addEventListener("keydown", (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 's') {
        e.preventDefault();
        if (!scanBtn.disabled) scanBtn.click();
      } else if (k === 'a') {
        e.preventDefault();
        runAIVerification();
      } else if (k === 't') {
        e.preventDefault();
        themeBtn.click();
      } else if (k === 'r') {
        e.preventDefault();
        if (resetBtn && !resetBtn.disabled) resetBtn.click();
      }
    }
  });

  function isInternalUrl(url) {
    if (!url) return true;
    return url.startsWith("chrome://") ||
           url.startsWith("chrome-extension://") ||
           url.startsWith("edge://") ||
           url.startsWith("about:") ||
           url.startsWith("devtools://");
  }

  let tab = null;
  try {
    const currentTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (currentTabs && currentTabs.length > 0 && !isInternalUrl(currentTabs[0].url)) {
      tab = currentTabs[0];
    }
    // If active tab is internal (e.g. welcome.html), search for an open HTTP/HTTPS portal tab in current window
    if (!tab) {
      const allWindowTabs = await chrome.tabs.query({ currentWindow: true });
      const candidateTab = (allWindowTabs || []).find(t => t.url && !isInternalUrl(t.url));
      if (candidateTab) {
        tab = candidateTab;
      }
    }
    // Search last focused window if needed
    if (!tab) {
      const lastTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (lastTabs && lastTabs.length > 0 && !isInternalUrl(lastTabs[0].url)) {
        tab = lastTabs[0];
      }
    }
    // Search all windows if still not found
    if (!tab) {
      const anyTabs = await chrome.tabs.query({});
      const anyWebTab = (anyTabs || []).find(t => t.url && !isInternalUrl(t.url));
      if (anyWebTab) {
        tab = anyWebTab;
      }
    }
  } catch (_) {}

  const isCurrentTabInternal = !tab || !tab.id || !tab.url || isInternalUrl(tab.url);

  if (isCurrentTabInternal) {
    setSetupPageState();
  } else {
    connectToContentScript();
  }

  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === "UPDATE_STATUS" && request.result) updateUI(request.result);
    if (request.action === "EXTENSION_TOGGLED") updateToggleUI(request.enabled);
    if (request.action === "THEME_TOGGLED") applyTheme(request.theme);
  });

  enableToggle.addEventListener("click", () => {
    const nowEnabled = enableToggle.classList.contains("off");
    updateToggleUI(nowEnabled);
    chrome.storage.local.set({ extensionEnabled: nowEnabled });
    if (tab && tab.id && !isInternalUrl(tab.url)) {
      chrome.tabs.sendMessage(tab.id, { action: "TOGGLE_EXTENSION", enabled: nowEnabled }, () => {
        if (chrome.runtime.lastError) {
          autoInjectAndConnect();
        }
      });
    }
  });

  scanBtn.addEventListener("click", () => {
    if (!tab || !tab.id || isInternalUrl(tab.url)) {
      resultText.innerText = "Switch to Bank Tab";
      resultSub.innerText = "Open or switch to your target banking / LOS portal tab to scan.";
      resultText.className = "result-label none";
      setResultIcon('ic-info', '--accent');
      return;
    }
    scanBtn.disabled = true;
    scanBtn.innerHTML = '<div class="spinner"></div> Scanning...';

    chrome.tabs.sendMessage(tab.id, { action: "SCAN_NAMES" }, (response) => {
      if (chrome.runtime.lastError || !response) {
        autoInjectAndConnect();
      } else if (response.result) {
        updateUI(response.result);
      }
      setTimeout(() => {
        scanBtn.disabled = false;
        scanBtn.innerHTML = `
          <svg class="icon i13" viewBox="0 0 24 24"><use href="#ic-refresh"/></svg>Scan <span class="kbd-badge">Alt+S</span>`;
      }, 400);
    });
  });

  function renderAIResult(res) {
    if (!aiBox) return;
    if (!res || res.verdict === "OFF" || res.verdict === "NO_DATA" || (providerSelect && providerSelect.value === "disabled")) {
      aiBox.style.display = "none";
      return;
    }
    aiBox.style.display = "block";
    const vColor = res.verdict === "MATCH" ? "var(--success)" : res.verdict === "PARTIAL" ? "var(--warning)" : "var(--danger)";
    if (aiVerdict) {
      aiVerdict.innerText = `${res.verdict} (${res.confidence || 90}%)`;
      aiVerdict.style.color = vColor;
    }
    if (aiReason) {
      aiReason.innerText = res.reason || "Verified by AI.";
    }
  }

  function runAIVerification() {
    if (!tab || !tab.id || isInternalUrl(tab.url)) {
      resultText.innerText = "Switch to Bank Tab";
      resultSub.innerText = "Open or switch to your target banking / LOS portal tab to verify AI.";
      resultText.className = "result-label none";
      setResultIcon('ic-info', '--accent');
      return;
    }
    if (aiBtn) {
      aiBtn.disabled = true;
      aiBtn.innerHTML = '<div class="spinner"></div> Verifying AI...';
    }
    if (aiBox) {
      aiBox.style.display = "block";
      if (aiVerdict) {
        aiVerdict.innerText = "ANALYZING...";
        aiVerdict.style.color = "var(--accent)";
      }
      if (aiReason) aiReason.innerText = "Analyzing names with Indian Identity AI engine...";
    }

    chrome.tabs.sendMessage(tab.id, { action: "RUN_AI_VERIFY" }, (response) => {
      if (aiBtn) {
        aiBtn.disabled = false;
        aiBtn.innerHTML = `<svg class="icon i13" viewBox="0 0 24 24"><use href="#ic-sparkles"/></svg> AI <span class="kbd-badge">Alt+A</span>`;
      }
      if (chrome.runtime.lastError || !response || !response.success) {
        if (aiReason) aiReason.innerText = response?.error || "AI analysis failed or scanner not connected.";
        if (aiVerdict) {
          aiVerdict.innerText = "FAILED";
          aiVerdict.style.color = "var(--danger)";
        }
      } else if (response.result) {
        renderAIResult(response.result);
      }
    });
  }

  if (aiBtn) {
    aiBtn.addEventListener("click", () => {
      runAIVerification();
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      resetBtn.disabled = true;
      resetBtn.innerHTML = '<div class="spinner"></div> Resetting...';

      if (aiBox) aiBox.style.display = "none";

      const resetEmptyData = {
        scanned: false,
        customerId: null,
        maskedCustomerId: "—",
        profileName: "—",
        count: 0, matchCount: 0, partialCount: 0, mismatchCount: 0,
        mismatchFound: false, noElements: true, hasProfile: false,
        details: [], statements: [],
        profilePAN: null, bankPAN: null, panResult: null, bankAccountID: null,
        aiResult: null
      };
      updateUI(resetEmptyData);

      if (tab && tab.id && !isInternalUrl(tab.url)) {
        chrome.tabs.sendMessage(tab.id, { action: "RESET_SCAN" }, (response) => {
          if (response && response.result) {
            updateUI(response.result);
          }
        });
      }

      setTimeout(() => {
        resetBtn.disabled = false;
        resetBtn.innerHTML = `
          <svg class="icon i13" viewBox="0 0 24 24"><use href="#ic-rotate-ccw"/></svg>
          Reset Done`;
        setTimeout(() => {
          resetBtn.innerHTML = `
            <svg class="icon i13" viewBox="0 0 24 24"><use href="#ic-rotate-ccw"/></svg>
            Reset <span class="kbd-badge">Alt+R</span>`;
        }, 700);
      }, 300);
    });
  }

  function updateToggleUI(enabled) {
    enableToggle.className = `toggle-pill ${enabled ? "on" : "off"}`;
    enableToggle.innerText = enabled ? "ON" : "OFF";
  }

  function autoInjectAndConnect() {
    if (!tab || !tab.id || !tab.url || isInternalUrl(tab.url)) {
      setSetupPageState();
      return;
    }

    monitoringStatus.className = "badge inactive";
    statusText.innerText = "Connecting...";

    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["needle3_engine.js", "content.js"]
    }, () => {
      if (chrome.runtime.lastError) {
        setDisconnectedState();
      } else {
        chrome.tabs.sendMessage(tab.id, { action: "GET_STATUS" }, (response) => {
          if (!chrome.runtime.lastError && response) {
            setConnectedState();
            updateToggleUI(response.extensionEnabled !== false);
            if (response.theme) applyTheme(response.theme);
            if (response.result) updateUI(response.result);
          } else {
            setTimeout(() => {
              chrome.tabs.sendMessage(tab.id, { action: "GET_STATUS" }, (res2) => {
                if (!chrome.runtime.lastError && res2) {
                  setConnectedState();
                  updateToggleUI(res2.extensionEnabled !== false);
                  if (res2.theme) applyTheme(res2.theme);
                  if (res2.result) updateUI(res2.result);
                } else {
                  setDisconnectedState();
                }
              });
            }, 200);
          }
        });
      }
    });
  }

  function connectToContentScript() {
    chrome.tabs.sendMessage(tab.id, { action: "GET_STATUS" }, (response) => {
      if (chrome.runtime.lastError || !response) {
        autoInjectAndConnect();
      } else {
        setConnectedState();
        updateToggleUI(response.extensionEnabled !== false);
        if (response.theme) applyTheme(response.theme);
        if (response.result) updateUI(response.result);
      }
    });
  }

  function setConnectedState() {
    monitoringStatus.className = "badge active";
    statusText.innerText = "Monitoring";
    contentContainer.classList.add("visible");
  }

  function setSetupPageState() {
    monitoringStatus.className = "badge active";
    statusText.innerText = "Setup Tab";
    contentContainer.classList.add("visible");
    if (valAppId) { valAppId.innerText = "—"; valAppId.title = ""; }
    valProfile.innerText = "Setup & Engine Ready";
    valCount.innerText = valMatch.innerText = valPartial.innerText = valMismatch.innerText = "0";
    setResultIcon('ic-shield', '--accent');
    resultText.innerText = "Engine Ready";
    resultText.className = "result-label match";
    resultSub.innerText = "Open your bank or LOS portal tab to scan customer KYC profiles.";
    partialPanel.classList.remove("visible");
    setPANDisplay(null, null, null);
    setAccountTypeDisplay(null);
    setOverallDisplay(null);
    setAccountIDsDisplay([], null);
  }

  function setDisconnectedState() {
    monitoringStatus.className = "badge inactive";
    statusText.innerText = "Inactive";
    contentContainer.classList.add("visible");
    if (valAppId) { valAppId.innerText = "—"; valAppId.title = ""; }
    valProfile.innerText = "N/A";
    valCount.innerText = valMatch.innerText = valPartial.innerText = valMismatch.innerText = "0";
    setResultIcon('ic-plug', '--muted');
    resultText.innerText = "Click Badge to Reconnect";
    resultText.className = "result-label none";
    resultSub.innerText = "Auto-reconnecting scanner...";
    partialPanel.classList.remove("visible");
    setPANDisplay(null, null, null);
    setAccountTypeDisplay(null);
    setOverallDisplay(null);
    setAccountIDsDisplay([], null);
  }

  function updateUI(data) {
    if (valAppId) {
      valAppId.innerText = data.maskedCustomerId || data.customerId || "—";
      valAppId.title = data.customerId ? `Customer ID: ${data.customerId}` : "";
    }
    valProfile.innerText = data.profileName || "Not found";
    valProfile.title     = data.profileName || "";
    valCount.innerText   = data.count       ?? "0";
    valMatch.innerText   = data.isVerifying ? "0" : (data.matchCount  ?? "0");
    valPartial.innerText = data.isVerifying ? "0" : (data.partialCount ?? "0");
    valMismatch.innerText= data.isVerifying ? "0" : (data.mismatchCount ?? "0");

    if (data.profileName === "Domain Not Authorized") {
      setResultIcon('ic-lock', '--danger');
      resultText.innerText = "Domain Not Authorized";
      resultText.className = "result-label mismatch";
      resultSub.innerText  = "Open Settings to add domain or allow '*'";
      resultBox.style.borderColor = "var(--danger)";
      resultBox.style.background  = "var(--badge-miss-bg)";
      partialPanel.classList.remove("visible");

    } else if (data.profileName === "Detecting profile...") {
      setResultIcon('ic-refresh', '--accent', true);
      resultText.innerText = "Detecting Profile...";
      resultText.className = "result-label partial";
      resultSub.innerText  = "Switching path / detecting new profile...";
      resultBox.style.borderColor = "var(--accent)";
      resultBox.style.background  = "var(--accent-wash)";
      partialPanel.classList.remove("visible");

    } else if (data.isVerifying) {
      setResultIcon('ic-refresh', '--accent', true);
      resultText.innerText = "Analyzing Name Compatibility...";
      resultText.className = "result-label partial";
      resultSub.innerText  = "Verifying match details on dashboard...";
      resultBox.style.borderColor = "var(--accent)";
      resultBox.style.background  = "var(--accent-wash)";
      partialPanel.classList.remove("visible");

    } else if (!data.scanned || data.noElements) {
      setResultIcon('ic-search', '--muted');
      resultText.innerText = data.noElements ? "No accounts found" : "Waiting for data";
      resultText.className = "result-label none";
      resultSub.innerText  = "";
      resultBox.style.borderColor = "var(--border)";
      resultBox.style.background  = "var(--card2)";
      partialPanel.classList.remove("visible");

    } else if (data.mismatchFound) {
      setResultIcon('ic-x-circle', '--danger');
      resultText.innerText = "Manual Check Required";
      resultText.className = "result-label mismatch";
      const mismatched = (data.statements || []).filter(s => s.overallResult === "mismatch");
      const panCaused  = mismatched.some(s => ["Not_Match", "not_match", "mismatch"].includes(s.panResult?.result));
      const nameCaused = mismatched.some(s => s.nameResult === "mismatch");
      const reason = panCaused && !nameCaused ? "PAN mismatch detected"
                   : nameCaused && !panCaused ? "Name mismatch detected"
                   : mismatched.length ? "Name & PAN mismatch detected"
                   : "mismatch detected";
      resultSub.innerText  = `${data.mismatchCount} account${data.mismatchCount !== 1 ? "s" : ""} — ${reason}`;
      resultBox.style.borderColor = "var(--danger)";
      resultBox.style.background  = "var(--badge-miss-bg)";
      partialPanel.classList.remove("visible");

    } else if (data.partialCount > 0) {
      setResultIcon('ic-alert', '--warning');
      resultText.innerText = "Partial Match — Verify Manually";
      resultText.className = "result-label partial";
      resultSub.innerText  = `${data.partialCount} account${data.partialCount !== 1 ? "s" : ""} partially matched`;
      resultBox.style.borderColor = "var(--warning)";
      resultBox.style.background  = "var(--badge-warn-bg)";
      const fp = (data.details || []).find(d => d.result === "partial" && d.firstNameDiffers);
      if (fp) {
        fnProfile.innerText = fp.firstNameProfile || "—";
        fnBank.innerText    = fp.firstNameBank    || "—";
        partialPanel.classList.add("visible");
      } else {
        partialPanel.classList.remove("visible");
      }

    } else if (data.hasProfile === false || !data.profileName || data.profileName.includes("Profile") || data.profileName.includes("Not found") || data.profileName === "—") {
      setResultIcon('ic-search', '--muted');
      resultText.innerText = "Profile Name Required";
      resultText.className = "result-label none";
      resultSub.innerText  = "Switch to Profile tab to scan customer, or click Reset";
      resultBox.style.borderColor = "var(--border)";
      resultBox.style.background  = "var(--card2)";
      partialPanel.classList.remove("visible");

    } else {
      setResultIcon('ic-check-circle', '--success');
      resultText.innerText = "All Names Match";
      resultText.className = "result-label match";
      resultSub.innerText  = `${data.count} account${data.count !== 1 ? "s" : ""} verified`;
      resultBox.style.borderColor = "var(--success)";
      resultBox.style.background  = "var(--badge-match-bg)";
      partialPanel.classList.remove("visible");
    }

    setPANDisplay(data.profilePAN, data.bankPAN, data.panResult);
    setAccountTypeDisplay(data);
    setOverallDisplay(data);
    setAccountIDsDisplay(data.statements || [], data.bankAccountID);

    if (data.aiResult) {
      renderAIResult(data.aiResult);
    } else if (aiBox) {
      aiBox.style.display = "none";
    }
  }

  // Worst account type across the scanned statements — risk/blank accounts require
  // the operator to check minus transactions in sheet.
  function worstAccountInfo(data) {
    if (!data) return null;
    const statements = data.statements || [];
    const infos = statements.map(s => s.accountInfo).filter(Boolean);
    if (infos.length > 0) {
      return infos.find(a => a.level === 'risk')
          || infos.find(a => a.level === 'blank')
          || infos.find(a => a.level === 'unknown')
          || infos[0];
    }
    if (data.accountInfo) return data.accountInfo;
    if (data.accountType) {
      const raw = String(data.accountType).trim().toUpperCase();
      if (/OVER[\s\-_]*DRAFT|CURRENT|OD\b|ODA\b|CA\b/i.test(raw)) {
        return { level: 'risk', label: raw.includes('OVER') || /OD/i.test(raw) ? 'OVERDRAFT (OD/ODA)' : 'CURRENT ACCOUNT', provided: true, display: raw };
      }
      if (/SAVING|SALAR/i.test(raw)) {
        return { level: 'safe', label: /SALAR/i.test(raw) ? 'SALARY ACCOUNT' : 'SAVINGS', provided: true, display: raw };
      }
      return { level: 'unknown', label: raw, provided: true, display: raw };
    }
    return null;
  }

  function setAccountTypeDisplay(data) {
    const info = data ? worstAccountInfo(data) : null;
    acctAlertInfo.classList.remove("visible");
    valAcctType.style.color = "";
    valAcctType.style.fontWeight = "";

    if (!data || !data.scanned) {
      valAcctType.innerText = "—";
      acctBadge.className   = "pan-badge none";
      acctBadge.innerText   = "— Waiting";
      return;
    }

    if (!info || !info.provided || info.level === 'blank') {
      valAcctType.innerText = (info && info.raw) ? info.raw : "—";
      valAcctType.style.color = "var(--warning)";
      acctBadge.className   = "pan-badge partial";
      acctBadge.innerText   = "🟡 NOT PROVIDED";
      acctAlertInfo.innerHTML = `<span style="color:var(--warning);font-weight:700;">⚠️ Check minus trans in sheet manual verify</span>`;
      acctAlertInfo.classList.add("visible");
      return;
    }

    valAcctType.innerText = info.display || info.raw || info.label || "—";

    if (info.level === 'safe' || info.category === 'savings') {
      acctBadge.className = "pan-badge match";
      acctBadge.innerText = `🟢 ${info.label}`;
      valAcctType.style.color = "var(--success)";
      valAcctType.style.fontWeight = "700";
      acctAlertInfo.innerHTML = `<span style="color:var(--success);font-weight:600;">✓ ${info.label} (Safe)</span>`;
      acctAlertInfo.classList.add("visible");
    } else if (info.level === 'risk') {
      acctBadge.className = "pan-badge not-match";
      acctBadge.innerText = `🔴 ${info.label}`;
      valAcctType.style.color = "var(--danger)";
      valAcctType.style.fontWeight = "800";
      acctAlertInfo.innerHTML = `<span style="color:var(--danger);font-weight:700;">⚠️ Check minus trans in sheet manual verify</span>`;
      acctAlertInfo.classList.add("visible");
    } else {
      acctBadge.className = "pan-badge partial";
      acctBadge.innerText = `🟡 ${info.label}`;
      valAcctType.style.color = "var(--warning)";
      valAcctType.style.fontWeight = "700";
      acctAlertInfo.innerHTML = `<span style="color:var(--warning);font-weight:700;">⚠️ Check minus trans in sheet manual verify</span>`;
      acctAlertInfo.classList.add("visible");
    }
  }

  const OVERALL_TEXT = {
    verified: ["match",     "✅ VERIFIED"],
    failed:   ["not-match", "❌ VERIFICATION FAILED"],
    alert:    ["not-match", "🔴 ALERT"],
    review:   ["partial",   "⚠ REVIEW"],
    unable:   ["none",      "⚠ UNABLE TO VERIFY"],
    pending:  ["none",      "… VERIFYING"]
  };

  // Worst verdict wins: one failed statement is not cancelled out by a clean one.
  const OVERALL_RANK = { failed: 5, alert: 4, unable: 3, review: 2, pending: 1, verified: 0 };

  function setOverallDisplay(data) {
    overallInfo.classList.remove("visible");
    const verifications = (data && data.statements || []).map(s => s.verification).filter(Boolean);

    if (verifications.length === 0) {
      overallBadge.className = "pan-badge none";
      overallBadge.innerText = data && data.scanned ? "— No statements" : "— Waiting for data";
      return;
    }

    let worst = verifications[0];
    for (const v of verifications) {
      if ((OVERALL_RANK[v.overall] ?? 0) > (OVERALL_RANK[worst.overall] ?? 0)) worst = v;
    }

    const [cls, text] = OVERALL_TEXT[worst.overall] || OVERALL_TEXT.review;
    overallBadge.className = `pan-badge ${cls}`;
    overallBadge.innerText = text;

    if (worst.overall === 'unable' && worst.missing.length > 0) {
      overallInfo.innerHTML = `<span style="color:var(--muted);font-weight:600;">Missing: ${worst.missing.join(", ")}</span>`;
      overallInfo.classList.add("visible");
    } else if (worst.overall === 'alert') {
      overallInfo.innerHTML = `<span style="color:var(--danger);font-weight:600;">${worst.account.alert || 'CURRENT/OD account detected'}</span>`;
      overallInfo.classList.add("visible");
    } else if (worst.overall === 'failed') {
      const reason = worst.pan.status === 'mismatch' ? 'PAN mismatch'
                   : worst.name.status === 'mismatch' ? 'Name mismatch'
                   : 'Verification failed';
      overallInfo.innerHTML = `<span style="color:var(--danger);font-weight:600;">${reason}</span>`;
      overallInfo.classList.add("visible");
    } else if (worst.overall === 'verified' && worst.name.confidence != null) {
      overallInfo.innerHTML = `<span style="color:var(--success);font-weight:600;">Name confidence ${worst.name.confidence}%</span>`;
      overallInfo.classList.add("visible");
    }
  }

  function setPANDisplay(profilePAN, bankPAN, panResult) {
    const cleanProfilePAN = (profilePAN && profilePAN !== "-" && profilePAN !== "—") ? profilePAN : "—";
    const cleanBankPAN    = (bankPAN && bankPAN !== "-" && bankPAN !== "—") ? bankPAN : "—";
    valProfilePAN.innerText = cleanProfilePAN;
    valBankPAN.innerText    = cleanBankPAN;
    valBankPAN.style.color  = "";
    valBankPAN.style.fontWeight = "";
    panPartialInfo.classList.remove("visible");

    if (!panResult || panResult.result === "Pan_Not_Present" || panResult.result === "pan_not_present" || panResult.result === "unavailable") {
      panBadge.className   = "pan-badge pan-not-present";
      panBadge.innerText   = "— Pan_Not_Present";
      return;
    }

    const res = panResult.result;
    if (res === "Match" || res === "match") {
      panBadge.className   = "pan-badge match";
      panBadge.innerText   = "✓ Match";
      valBankPAN.style.color = "var(--success)";
      valBankPAN.style.fontWeight = "700";
      if (panResult.matchLen === 4 || (panResult.matchedPart && panResult.matchedPart.length === 4)) {
        panPartialInfo.innerHTML = `✓ Last 4 unmasked match: <span class="pan-highlight">${panResult.matchedPart}</span>`;
        panPartialInfo.classList.add("visible");
      } else if (panResult.matchLen === 10) {
        panPartialInfo.innerHTML = `<span style="color:var(--success);font-weight:600;">✓ Full PAN matching with Input</span>`;
        panPartialInfo.classList.add("visible");
      } else if (panResult.reason) {
        panPartialInfo.innerHTML = `<span style="color:var(--success);font-weight:600;">✓ ${panResult.reason}</span>`;
        panPartialInfo.classList.add("visible");
      }
    } else if (res === "Not_Match" || res === "not_match" || res === "mismatch") {
      panBadge.className   = "pan-badge not-match";
      panBadge.innerText   = "✕ Not_Match";
      valBankPAN.style.color = "var(--danger)";
      valBankPAN.style.fontWeight = "800";
      panPartialInfo.innerHTML = `<span style="color:var(--danger);font-weight:700;">✕ Different PAN (Not_Match)</span>`;
      panPartialInfo.classList.add("visible");
    } else if (res === "Invalid_PAN" || res === "invalid_pan") {
      panBadge.className   = "pan-badge invalid-pan";
      panBadge.innerText   = "⚠ Invalid_PAN";
      valBankPAN.style.color = "var(--warning)";
      valBankPAN.style.fontWeight = "700";
      const invalidNote = (cleanBankPAN !== "—") ? cleanBankPAN : "Form16/Form60/Not PAN";
      panPartialInfo.innerHTML = `<span style="color:var(--warning);font-weight:600;">⚠ Invalid PAN (${invalidNote})</span>`;
      panPartialInfo.classList.add("visible");
    } else if (res === "Not_Applicable" || res === "not_applicable") {
      panBadge.className   = "pan-badge pan-not-present";
      panBadge.innerText   = "— Not_Applicable";
      panPartialInfo.innerHTML = `<span style="color:var(--muted);font-weight:600;">Salary not confirmed</span>`;
      panPartialInfo.classList.add("visible");
    } else {
      panBadge.className   = "pan-badge pan-not-present";
      panBadge.innerText   = "— Pan_Not_Present";
    }
  }

  function setAccountIDsDisplay(statements, fallbackID) {
    acctIdsList.innerHTML = "";

    const rows = statements.length > 0
      ? statements.map(st => ({
          index:     st.index,
          accountID: st.accountID,
          result:    st.overallResult,
          canCopy:   st.copyEnabled
        }))
      : fallbackID
        ? [{ index: null, accountID: fallbackID, result: "match", canCopy: true }]
        : [];

    if (rows.length === 0) {
      acctIdsList.innerHTML = `<span style="color:var(--muted);font-size:11px;">—</span>`;
      return;
    }

    rows.forEach(row => {
      const badgeCls = row.result === "match" ? "match" : row.result === "partial" ? "partial" : "miss";
      const badgeIcon = row.result === "match" ? "✓" : row.result === "partial" ? "~" : "✕";

      const item = document.createElement("div");
      item.className = "acct-id-item";
      item.innerHTML = `
        <div style="display:flex;align-items:center;gap:5px;min-width:0;">
          ${row.index !== null ? `<span class="acct-item-num">#${row.index}</span>` : ""}
          <span class="acct-item-id${row.accountID ? "" : " dim"}">${row.accountID || "—"}</span>
        </div>
        <div style="display:flex;align-items:center;gap:5px;flex-shrink:0;">
          <span class="acct-item-badge ${badgeCls}">${badgeIcon}</span>
          <button class="copy-btn" ${!row.canCopy || !row.accountID ? "disabled" : ""} data-id="${row.accountID || ""}">
            ${copySVG} Copy
          </button>
        </div>`;

      if (row.canCopy && row.accountID) {
        item.querySelector(".copy-btn").addEventListener("click", async (e) => {
          const btn = e.currentTarget;
          try { await navigator.clipboard.writeText(row.accountID); } catch (_) {}
          btn.innerHTML = `${checkSVG} Copied!`;
          btn.classList.add("copied");
          setTimeout(() => { btn.innerHTML = `${copySVG} Copy`; btn.classList.remove("copied"); }, 2000);
        });
      }

      acctIdsList.appendChild(item);
    });
  }
});
