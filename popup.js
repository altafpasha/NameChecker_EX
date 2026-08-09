document.addEventListener("DOMContentLoaded", async () => {
  const scanBtn          = document.getElementById("scanBtn");
  const aiBtn            = document.getElementById("aiBtn");
  const themeBtn         = document.getElementById("themeBtn");
  const settingsBtn      = document.getElementById("settingsBtn");
  const settingsModal    = document.getElementById("settingsModal");
  const closeModalBtn    = document.getElementById("closeModalBtn");
  const apiKeyInput      = document.getElementById("apiKeyInput");
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

  const aiBox            = document.getElementById("ai-box");
  const aiVerdict        = document.getElementById("ai-verdict");
  const aiReason         = document.getElementById("ai-reason");

  const valProfilePAN    = document.getElementById("val-profile-pan");
  const valBankPAN       = document.getElementById("val-bank-pan");
  const panBadge         = document.getElementById("pan-badge");
  const panPartialInfo   = document.getElementById("pan-partial-info");
  const panMatchLen      = document.getElementById("pan-match-len");
  const panMatchPart     = document.getElementById("pan-match-part");
  const acctIdsList      = document.getElementById("acct-ids-list");

  const contentContainer = document.getElementById("content-container");
  const enableToggle     = document.getElementById("enable-toggle");

  const copySVG = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
  const checkSVG = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

  let currentTheme = 'dark';

  monitoringStatus.style.cursor = "pointer";
  monitoringStatus.title = "Click to auto-reconnect scanner to dashboard";
  monitoringStatus.addEventListener("click", () => {
    autoInjectAndConnect();
  });

  function applyTheme(theme) {
    currentTheme = theme || 'dark';
    document.documentElement.setAttribute('data-theme', currentTheme);
    themeBtn.innerText = currentTheme === 'light' ? '🌙' : '☀️';
  }

  const providerSelect = document.getElementById("providerSelect");
  const modalBadge     = document.getElementById("modalBadge");

  function updateModalBadge(provider) {
    if (provider === "huggingface") {
      modalBadge.innerText = "SmolLM-135M Instruct (Micro LLM ~270MB Size)";
      apiKeyInput.placeholder = "Enter HuggingFace Token (Optional)...";
    } else if (provider === "gemma") {
      modalBadge.innerText = "Google Gemma-2B Instruct Model";
      apiKeyInput.placeholder = "Enter HuggingFace Token...";
    } else if (provider === "local") {
      modalBadge.innerText = "Local Indian NLP Classifier (Zero API Key)";
      apiKeyInput.placeholder = "No API Key required for Local Engine";
    } else {
      modalBadge.innerText = "Google Gemini (Ultra-Fast Free Tier)";
      apiKeyInput.placeholder = "Enter API Key...";
    }
  }

  providerSelect.addEventListener("change", () => {
    updateModalBadge(providerSelect.value);
  });

  const allowedDomainsInput       = document.getElementById("allowedDomainsInput");
  const toggleDomainVisibilityBtn = document.getElementById("toggleDomainVisibilityBtn");

  if (toggleDomainVisibilityBtn) {
    toggleDomainVisibilityBtn.addEventListener("click", () => {
      if (allowedDomainsInput.type === "password") {
        allowedDomainsInput.type = "text";
        toggleDomainVisibilityBtn.innerText = "🙈";
      } else {
        allowedDomainsInput.type = "password";
        toggleDomainVisibilityBtn.innerText = "👁️";
      }
    });
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

  // Load theme and saved API key state
  chrome.storage.local.get(['theme', 'extensionEnabled', 'geminiApiKey', 'aiProvider', 'allowedDomains'], (res) => {
    applyTheme(res.theme || 'dark');
    updateToggleUI(res.extensionEnabled !== false);
    if (res.aiProvider) providerSelect.value = res.aiProvider;
    updateModalBadge(providerSelect.value);
    if (res.geminiApiKey) {
      apiKeyInput.value = "••••••••••••••••";
    }
    if (res.allowedDomains) {
      allowedDomainsInput.value = decryptDomainString(res.allowedDomains);
    } else {
      allowedDomainsInput.value = "ibnbfc.in";
    }
  });

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
    const key = apiKeyInput.value.trim();
    const selectedProvider = providerSelect.value;
    const rawDomains = allowedDomainsInput.value.trim();
    const normalizedDomains = rawDomains
      .split(/[\s,\n]+/)
      .map(d => d.trim())
      .filter(Boolean)
      .join(", ");
    const encDomains = encryptDomainString(normalizedDomains);

    chrome.storage.local.set({ aiProvider: selectedProvider, allowedDomains: encDomains });

    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, {
        action: "SAVE_SETTINGS",
        apiKey: key && !key.startsWith("••••") ? key : null,
        provider: selectedProvider,
        allowedDomains: encDomains
      }, () => {
        if (chrome.runtime.lastError) {}
      });
    }

    saveKeyBtn.innerText = "Saved!";
    setTimeout(() => {
      saveKeyBtn.innerText = "Save Settings";
      settingsModal.classList.remove("visible");
    }, 800);
  });

  clearKeyBtn.addEventListener("click", () => {
    apiKeyInput.value = "";
    chrome.storage.local.remove("geminiApiKey");
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, { action: "SAVE_API_KEY", apiKey: "" }, () => {
        if (chrome.runtime.lastError) {}
      });
    }
  });

  // Global Shortcut Listener in Popup Window
  document.addEventListener("keydown", (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 's') {
        e.preventDefault();
        if (!scanBtn.disabled) scanBtn.click();
      } else if (k === 'a') {
        e.preventDefault();
        if (!aiBtn.disabled) aiBtn.click();
      } else if (k === 't') {
        e.preventDefault();
        themeBtn.click();
      }
    }
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || tab.url.startsWith("chrome://") || tab.url.startsWith("edge://")) {
    setDisconnectedState();
    return;
  }

  connectToContentScript();

  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === "UPDATE_STATUS" && request.result) updateUI(request.result);
    if (request.action === "EXTENSION_TOGGLED") updateToggleUI(request.enabled);
    if (request.action === "THEME_TOGGLED") applyTheme(request.theme);
  });

  enableToggle.addEventListener("click", () => {
    const nowEnabled = enableToggle.classList.contains("off");
    updateToggleUI(nowEnabled);
    chrome.tabs.sendMessage(tab.id, { action: "TOGGLE_EXTENSION", enabled: nowEnabled }, () => {
      if (chrome.runtime.lastError) {
        autoInjectAndConnect();
      }
    });
  });

  scanBtn.addEventListener("click", () => {
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
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/>
            <path d="M21 3v5h-5"/>
          </svg>Force Scan`;
      }, 500);
    });
  });

  aiBtn.addEventListener("click", () => {
    aiBtn.disabled = true;
    aiBtn.innerHTML = '<div class="spinner"></div> AI Verifying...';

    chrome.tabs.sendMessage(tab.id, { action: "VERIFY_AI" }, (response) => {
      if (chrome.runtime.lastError || !response) {
        autoInjectAndConnect();
      } else if (response.aiResult) {
        renderAIResult(response.aiResult);
      }
      setTimeout(() => {
        aiBtn.disabled = false;
        aiBtn.innerHTML = '✨ Verify AI';
      }, 500);
    });
  });

  function updateToggleUI(enabled) {
    enableToggle.className = `toggle-pill ${enabled ? "on" : "off"}`;
    enableToggle.innerText = enabled ? "ON" : "OFF";
  }

  function autoInjectAndConnect() {
    if (!tab || !tab.id || tab.url.startsWith("chrome://") || tab.url.startsWith("edge://")) {
      setDisconnectedState();
      return;
    }

    monitoringStatus.className = "badge inactive";
    statusText.innerText = "Connecting...";

    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    }, () => {
      if (chrome.runtime.lastError) {
        setDisconnectedState();
      } else {
        setTimeout(() => {
          chrome.tabs.sendMessage(tab.id, { action: "GET_STATUS" }, (response) => {
            if (!chrome.runtime.lastError && response) {
              setConnectedState();
              updateToggleUI(response.extensionEnabled !== false);
              if (response.theme) applyTheme(response.theme);
              if (response.result) updateUI(response.result);
              if (response.aiResult) renderAIResult(response.aiResult);
            } else {
              setDisconnectedState();
            }
          });
        }, 300);
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
        if (response.aiResult) renderAIResult(response.aiResult);
      }
    });
  }

  function setConnectedState() {
    monitoringStatus.className = "badge active";
    statusText.innerText = "Monitoring";
    contentContainer.classList.add("visible");
  }

  function setDisconnectedState() {
    monitoringStatus.className = "badge inactive";
    statusText.innerText = "Inactive";
    contentContainer.classList.add("visible");
    valProfile.innerText = "N/A";
    valCount.innerText = valMatch.innerText = valPartial.innerText = valMismatch.innerText = "0";
    resultIcon.innerText = "🔌";
    resultText.innerText = "Click Badge to Reconnect";
    resultText.className = "result-label none";
    resultSub.innerText = "Auto-reconnecting scanner...";
    partialPanel.classList.remove("visible");
    aiBox.classList.remove("visible");
    setPANDisplay(null, null, null);
    setAccountIDsDisplay([], null);
  }

  function renderAIResult(res) {
    if (!res) { aiBox.classList.remove("visible"); return; }
    aiBox.classList.add("visible");
    const vColor = res.verdict === "MATCH" ? "var(--success)" : res.verdict === "PARTIAL" ? "var(--warning)" : "var(--danger)";
    aiVerdict.innerText = `${res.verdict} (${res.confidence || 90}%)`;
    aiVerdict.style.color = vColor;
    aiReason.innerText = res.reason || "AI analysis completed.";
  }

  function updateUI(data) {
    valProfile.innerText = data.profileName || "Not found";
    valProfile.title     = data.profileName || "";
    valCount.innerText   = data.count       ?? "0";
    valMatch.innerText   = data.matchCount  ?? "0";
    valPartial.innerText = data.partialCount ?? "0";
    valMismatch.innerText= data.mismatchCount ?? "0";

    if (!data.scanned || data.noElements) {
      resultIcon.innerText = "🔍";
      resultText.innerText = data.noElements ? "No accounts found" : "Waiting for data";
      resultText.className = "result-label none";
      resultSub.innerText  = "";
      resultBox.style.borderColor = "var(--border)";
      resultBox.style.background  = "rgba(255,255,255,.025)";
      partialPanel.classList.remove("visible");

    } else if (data.mismatchFound) {
      resultIcon.innerText = "❌";
      resultText.innerText = "Manual Check Required";
      resultText.className = "result-label mismatch";
      resultSub.innerText  = `${data.mismatchCount} account${data.mismatchCount !== 1 ? "s" : ""} — name mismatch detected`;
      resultBox.style.borderColor = "rgba(239,68,68,.3)";
      resultBox.style.background  = "rgba(239,68,68,.05)";
      partialPanel.classList.remove("visible");

    } else if (data.partialCount > 0) {
      resultIcon.innerText = "⚠️";
      resultText.innerText = "Partial Match — Verify Manually";
      resultText.className = "result-label partial";
      resultSub.innerText  = `${data.partialCount} account${data.partialCount !== 1 ? "s" : ""} partially matched`;
      resultBox.style.borderColor = "rgba(245,158,11,.3)";
      resultBox.style.background  = "rgba(245,158,11,.05)";
      const fp = (data.details || []).find(d => d.result === "partial" && d.firstNameDiffers);
      if (fp) {
        fnProfile.innerText = fp.firstNameProfile || "—";
        fnBank.innerText    = fp.firstNameBank    || "—";
        partialPanel.classList.add("visible");
      } else {
        partialPanel.classList.remove("visible");
      }

    } else {
      resultIcon.innerText = "✅";
      resultText.innerText = "All Names Match";
      resultText.className = "result-label match";
      resultSub.innerText  = `${data.count} account${data.count !== 1 ? "s" : ""} verified`;
      resultBox.style.borderColor = "rgba(34,197,94,.3)";
      resultBox.style.background  = "rgba(34,197,94,.05)";
      partialPanel.classList.remove("visible");
    }

    setPANDisplay(data.profilePAN, data.bankPAN, data.panResult);
    setAccountIDsDisplay(data.statements || [], data.bankAccountID);
  }

  function setPANDisplay(profilePAN, bankPAN, panResult) {
    valProfilePAN.innerText = profilePAN || "—";
    valBankPAN.innerText    = bankPAN    || "—";
    panPartialInfo.classList.remove("visible");

    if (!panResult || panResult.result === "unavailable") {
      panBadge.className   = "pan-badge none";
      panBadge.innerText   = "— Not available";
      return;
    }

    if (panResult.result === "match") {
      panBadge.className   = "pan-badge match";
      panBadge.innerText   = "✓ Full Match";
    } else if (panResult.result === "partial") {
      panBadge.className   = "pan-badge partial";
      panBadge.innerText   = `~ Partial (last ${panResult.matchLen})`;
      panMatchLen.innerText  = panResult.matchLen  || "?";
      panMatchPart.innerText = panResult.matchedPart || "—";
      panPartialInfo.classList.add("visible");
    } else {
      panBadge.className   = "pan-badge mismatch";
      panBadge.innerText   = "✕ Mismatch";
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
