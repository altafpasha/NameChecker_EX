document.addEventListener("DOMContentLoaded", async () => {
  const scanBtn          = document.getElementById("scanBtn");
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
  // PAN elements
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

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || tab.url.startsWith("chrome://") || tab.url.startsWith("edge://")) {
    setDisconnectedState();
    return;
  }

  // Reflect stored enabled state immediately before content script responds
  chrome.storage.local.get(['extensionEnabled'], (res) => {
    updateToggleUI(res.extensionEnabled !== false);
  });

  connectToContentScript();

  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === "UPDATE_STATUS" && request.result) updateUI(request.result);
    if (request.action === "EXTENSION_TOGGLED") updateToggleUI(request.enabled);
  });

  enableToggle.addEventListener("click", () => {
    const nowEnabled = enableToggle.classList.contains("off"); // flip
    updateToggleUI(nowEnabled);
    chrome.tabs.sendMessage(tab.id, { action: "TOGGLE_EXTENSION", enabled: nowEnabled }, () => {
      if (chrome.runtime.lastError) {} // content script may not be loaded
    });
  });


  scanBtn.addEventListener("click", () => {
    scanBtn.disabled = true;
    scanBtn.innerHTML = '<div class="spinner"></div> Scanning...';

    chrome.tabs.sendMessage(tab.id, { action: "SCAN_NAMES" }, (response) => {
      if (chrome.runtime.lastError || !response) {
        setDisconnectedState();
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

  function updateToggleUI(enabled) {
    enableToggle.className = `toggle-pill ${enabled ? "on" : "off"}`;
    enableToggle.innerText = enabled ? "ON" : "OFF";
    if (!enabled) scanBtn.disabled = true;
  }

  function connectToContentScript() {
    chrome.tabs.sendMessage(tab.id, { action: "GET_STATUS" }, (response) => {
      if (chrome.runtime.lastError || !response) {
        setDisconnectedState();
      } else {
        setConnectedState();
        updateToggleUI(response.extensionEnabled !== false);
        if (response.result) updateUI(response.result);
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
    scanBtn.disabled = true;
    valProfile.innerText = "N/A";
    valCount.innerText = valMatch.innerText = valPartial.innerText = valMismatch.innerText = "0";
    resultIcon.innerText = "⚠️";
    resultText.innerText = "Cannot scan this page";
    resultText.className = "result-label none";
    resultSub.innerText = "";
    partialPanel.classList.remove("visible");
    setPANDisplay(null, null, null);
    setAccountIDsDisplay([], null);
  }

  function updateUI(data) {
    // ── Name check section ──────────────────────
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
      resultText.innerText = "Mismatch Detected";
      resultText.className = "result-label mismatch";
      resultSub.innerText  = `${data.mismatchCount} account${data.mismatchCount !== 1 ? "s" : ""} don't match`;
      resultBox.style.borderColor = "rgba(239,68,68,.3)";
      resultBox.style.background  = "rgba(239,68,68,.05)";
      partialPanel.classList.remove("visible");

    } else if (data.partialCount > 0) {
      resultIcon.innerText = "⚠️";
      resultText.innerText = "Partial Match Found";
      resultText.className = "result-label partial";
      resultSub.innerText  = `${data.partialCount} account${data.partialCount !== 1 ? "s" : ""} partially match`;
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

    // ── PAN section ─────────────────────────────
    setPANDisplay(data.profilePAN, data.bankPAN, data.panResult);

    // ── Account IDs list ─────────────────────────
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

    // Build rows from per-statement data when available
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
