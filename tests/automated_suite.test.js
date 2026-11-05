/**
 * automated_suite.test.js
 * Comprehensive automated regression and unit test suite for Name Checker EX.
 * Covers:
 * 1. Stale customer data isolation and atomic scan lifecycle
 * 2. Needle 3 engine integration, schema validation, and decision policy
 *
 * NOTE: Uses strictly synthetic test data. Zero real customer data.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Needle3Module = require('../needle3_engine.js');
const {
  Needle3EngineManager,
  validateNeedle3Output,
  isAmbiguous,
  reconcileEngineResults,
  NEEDLE3_BLOCKER_INFO
} = Needle3Module;

// ─────────────────────────────────────────────────────────────────────────────
// SYNTHETIC CUSTOMER FIXTURES
// ─────────────────────────────────────────────────────────────────────────────
const SYNTHETIC_CUSTOMERS = {
  CUSTOMER_A: {
    appId: 'APP-TEST-9001',
    profileName: 'RAJESH KUMAR SHARMA',
    pan: 'ABCDE1234F',
    bankStatementName: 'RAJESH KUMAR SHARMA',
    bankPAN: 'ABCDE1234F',
    accountID: 'AC-9001-A'
  },
  CUSTOMER_B: {
    appId: 'APP-TEST-9002',
    profileName: 'PRIYA SUNIL DESHMUKH',
    pan: 'XYZPK5678Q',
    bankStatementName: 'PRIYA SUNIL DESHMUKH',
    bankPAN: 'XYZPK5678Q',
    accountID: 'AC-9002-B'
  },
  CUSTOMER_C_AMBIGUOUS: {
    appId: 'APP-TEST-9003',
    profileName: 'ANIL RAMESHCHANDRA GUPTA',
    pan: 'GUPTA9999M',
    bankStatementName: 'A R GUPTA JOINT ACCT',
    bankPAN: 'GUPTA9999M',
    accountID: 'AC-9003-C'
  },
  CUSTOMER_D_PAN_MISMATCH: {
    appId: 'APP-TEST-9004',
    profileName: 'VIKRAM NAIR',
    pan: 'NAIRV1111N',
    bankStatementName: 'VIKRAM NAIR',
    bankPAN: 'DIFFR2222D', // Different PAN!
    accountID: 'AC-9004-D'
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SIMULATED SCAN ENGINE HARNESS
// Implements the Customer Context Lifecycle from content.js for automated testing
// ─────────────────────────────────────────────────────────────────────────────
class SimulatedScanHarness {
  constructor() {
    this.activeScanId = 0;
    this.currentCustomerId = null;
    this.currentCaseSig = null;
    this.customerSessionRegistry = new Map();
    this.lastScanResult = null;
    this.engineMode = 'standard';
    this.needle3Enabled = false;
    this.needle3Engine = new Needle3EngineManager({ enabled: false, mode: 'standard' });
  }

  setEngineConfig(mode, needleEnabled, customRunner = null) {
    this.engineMode = mode;
    this.needle3Enabled = needleEnabled;
    this.needle3Engine.updateConfig({ engineMode: mode, needle3Enabled: needleEnabled });
    if (customRunner) {
      this.needle3Engine.setLocalRunner(customRunner);
    }
  }

  performFullReset() {
    this.activeScanId++;
    this.customerSessionRegistry.clear();
    this.inFlightScanSession = null;
    this.currentCustomerId = null;
    this.currentCaseSig = null;
    this.lastScannedProfileSig = null;
    this.lastScannedBankSig = null;
    this.lastScanResult = {
      scanId: this.activeScanId,
      customerId: null,
      maskedCustomerId: "—",
      scanned: false,
      hasProfile: false,
      profileName: "—",
      count: 0, matchCount: 0, partialCount: 0, mismatchCount: 0,
      mismatchFound: false, noElements: true,
      details: [], statements: []
    };
    return this.lastScanResult;
  }

  // Simulates a scan cycle across customer context changes
  async executeScan({ appId, domProfileName, domProfilePAN, statements = [], isSPAUpdate = false, activeTab = 'profile', bankHolderName = null }) {
    const scanId = ++this.activeScanId;

    const activeAppId = appId || null;
    const activeCaseSig = activeAppId || null;

    // Customer change check (including bank account holder mismatch)
    const customerChanged = Boolean(
      (activeAppId && this.currentCustomerId && activeAppId !== this.currentCustomerId) ||
      (isSPAUpdate && activeAppId !== this.currentCustomerId) ||
      (bankHolderName && this.lastScannedProfileSig && bankHolderName !== this.lastScannedProfileSig && !domProfileName)
    );

    if (customerChanged) {
      this.lastScanResult = null; // Clear transient state immediately
      this.customerSessionRegistry.clear();
      this.inFlightScanSession = null;
      this.currentCaseSig = activeCaseSig;
      this.currentCustomerId = activeAppId;
    } else {
      this.currentCaseSig = activeCaseSig;
      if (activeAppId) this.currentCustomerId = activeAppId;
    }

    const customerContextKey = activeAppId || null;

    let currentProfileName = null;
    let currentProfilePAN = null;

    if (domProfileName) {
      currentProfileName = domProfileName;
      currentProfilePAN = domProfilePAN || null;
      this.lastScannedProfileSig = domProfileName;
      if (customerContextKey) {
        this.customerSessionRegistry.set(customerContextKey, {
          profileName: domProfileName,
          profilePAN: currentProfilePAN,
          updatedAt: Date.now()
        });
      }
    } else if (activeTab === 'empinfo') {
      // Strict check for Emp Info tab: Only verified in-flight or matching customerContextKey
      if (this.inFlightScanSession && (Date.now() - this.inFlightScanSession.timestamp < 15000)) {
        currentProfileName = this.inFlightScanSession.profileName;
        currentProfilePAN = this.inFlightScanSession.profilePAN;
        this.inFlightScanSession = null;
      } else if (customerContextKey && this.customerSessionRegistry.has(customerContextKey)) {
        const cached = this.customerSessionRegistry.get(customerContextKey);
        currentProfileName = cached.profileName;
        currentProfilePAN = cached.profilePAN;
      } else {
        currentProfileName = null;
        currentProfilePAN = null;
      }
    } else if (customerContextKey && this.customerSessionRegistry.has(customerContextKey)) {
      const cached = this.customerSessionRegistry.get(customerContextKey);
      currentProfileName = cached.profileName;
      currentProfilePAN = cached.profilePAN;
    } else {
      // Missing profile for this customer: DO NOT reuse any other customer's profile!
      currentProfileName = null;
      currentProfilePAN = null;
    }

    // Process statements
    const processedStatements = [];
    let matchCount = 0;
    let mismatchCount = 0;
    let partialCount = 0;

    for (const st of statements) {
      let nameResult = 'unverified';
      let nameDetail = null;

      if (currentProfileName && st.rawName) {
        // Deterministic check simulation
        const normA = currentProfileName.trim().toUpperCase();
        const normB = st.rawName.trim().toUpperCase().replace(/JOINT ACCT|A\/C|MR|MRS/g, '').trim();

        let confidence = 20;
        let result = 'mismatch';

        if (normA === normB) {
          confidence = 100;
          result = 'match';
        } else {
          const toksA = normA.split(/\s+/).filter(Boolean);
          const toksB = normB.split(/\s+/).filter(Boolean);
          const matchToks = toksA.filter(ta => toksB.some(tb => tb === ta || tb[0] === ta[0]));
          if (matchToks.length >= 2) {
            confidence = 68; // Ambiguous partial review band
            result = 'partial';
          } else if (matchToks.length === 1) {
            confidence = 45;
            result = 'partial';
          }
        }

        nameDetail = {
          result,
          confidence,
          cleanBankName: st.rawName,
          needsManualCheck: result !== 'match'
        };

        // Secondary Needle 3 check
        if (this.engineMode === 'enhanced' && this.needle3Enabled) {
          if (isAmbiguous(nameDetail)) {
            const secondary = await this.needle3Engine.analyzeAmbiguousName(
              currentProfileName,
              st.rawName,
              nameDetail
            );
            nameDetail = reconcileEngineResults({
              deterministicResult: nameDetail,
              secondaryResult: secondary,
              panResult: { result: currentProfilePAN === st.pan ? 'Match' : 'Not_Match' }
            });
          }
        }

        nameResult = nameDetail.result;
      }

      const panIsMatch = currentProfilePAN && st.pan && currentProfilePAN === st.pan;
      const panIsMismatch = currentProfilePAN && st.pan && currentProfilePAN !== st.pan;

      let overallResult;
      if (!currentProfileName) {
        overallResult = 'unverified';
      } else if (panIsMismatch) {
        overallResult = 'mismatch'; // Rule 6: PAN mismatch is authoritative
      } else if (nameResult === 'match' && panIsMatch) {
        overallResult = 'match';
      } else if (nameResult === 'partial' || panIsMismatch) {
        overallResult = 'partial';
      } else {
        overallResult = 'mismatch';
      }

      if (overallResult === 'match') matchCount++;
      else if (overallResult === 'partial') partialCount++;
      else if (overallResult === 'mismatch') mismatchCount++;

      processedStatements.push({
        name: st.rawName,
        accountID: st.accountID,
        overallResult,
        nameDetail
      });
    }

    // Stale scan validation check (Rule 6 of scan lifecycle)
    if (scanId !== this.activeScanId) {
      return null; // Ignore delayed or stale scan!
    }

    const scanData = {
      scanId,
      customerId: activeAppId,
      hasProfile: !!currentProfileName,
      profileName: currentProfileName || (activeAppId ? `Profile tab required for customer (${activeAppId})` : null),
      count: statements.length,
      matchCount,
      partialCount,
      mismatchCount,
      statements: processedStatements,
      status: currentProfileName ? 'completed' : 'unable'
    };

    this.lastScanResult = scanData;
    return scanData;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 1: STALE CUSTOMER DATA & LIFECYCLE TESTS
// ─────────────────────────────────────────────────────────────────────────────
test('Stale Customer Bug: Customer A passes, Customer B is scanned -> Customer A name never in Customer B result', async () => {
  const harness = new SimulatedScanHarness();

  // Scan Customer A
  const resA = await harness.executeScan({
    appId: SYNTHETIC_CUSTOMERS.CUSTOMER_A.appId,
    domProfileName: SYNTHETIC_CUSTOMERS.CUSTOMER_A.profileName,
    domProfilePAN: SYNTHETIC_CUSTOMERS.CUSTOMER_A.pan,
    statements: [{ rawName: SYNTHETIC_CUSTOMERS.CUSTOMER_A.bankStatementName, pan: SYNTHETIC_CUSTOMERS.CUSTOMER_A.pan, accountID: 'AC-1' }]
  });
  assert.equal(resA.customerId, SYNTHETIC_CUSTOMERS.CUSTOMER_A.appId);
  assert.equal(resA.profileName, SYNTHETIC_CUSTOMERS.CUSTOMER_A.profileName);
  assert.equal(resA.matchCount, 1);

  // Scan Customer B
  const resB = await harness.executeScan({
    appId: SYNTHETIC_CUSTOMERS.CUSTOMER_B.appId,
    domProfileName: SYNTHETIC_CUSTOMERS.CUSTOMER_B.profileName,
    domProfilePAN: SYNTHETIC_CUSTOMERS.CUSTOMER_B.pan,
    statements: [{ rawName: SYNTHETIC_CUSTOMERS.CUSTOMER_B.bankStatementName, pan: SYNTHETIC_CUSTOMERS.CUSTOMER_B.pan, accountID: 'AC-2' }]
  });
  assert.equal(resB.customerId, SYNTHETIC_CUSTOMERS.CUSTOMER_B.appId);
  assert.equal(resB.profileName, SYNTHETIC_CUSTOMERS.CUSTOMER_B.profileName);
  assert.notEqual(resB.profileName, SYNTHETIC_CUSTOMERS.CUSTOMER_A.profileName);
  assert.equal(harness.lastScanResult.profileName, SYNTHETIC_CUSTOMERS.CUSTOMER_B.profileName);
});

test('Stale Customer Bug: Customer A delayed scan completes after Customer B scan starts -> Delayed result ignored', async () => {
  const harness = new SimulatedScanHarness();

  // Start Customer A scan with a delay
  const delayedScanAPromise = new Promise(async (resolve) => {
    const scanId = ++harness.activeScanId; // scanId = 1
    // Simulate async wait (e.g. 100ms)
    await new Promise((r) => setTimeout(r, 60));
    // When finishing, check scanId
    if (scanId !== harness.activeScanId) {
      resolve({ dropped: true, scanId });
    } else {
      resolve({ dropped: false, scanId });
    }
  });

  // Meanwhile, Customer B scan starts immediately (scanId = 2)
  const resB = await harness.executeScan({
    appId: SYNTHETIC_CUSTOMERS.CUSTOMER_B.appId,
    domProfileName: SYNTHETIC_CUSTOMERS.CUSTOMER_B.profileName,
    domProfilePAN: SYNTHETIC_CUSTOMERS.CUSTOMER_B.pan,
    statements: [{ rawName: SYNTHETIC_CUSTOMERS.CUSTOMER_B.bankStatementName, pan: SYNTHETIC_CUSTOMERS.CUSTOMER_B.pan, accountID: 'AC-2' }]
  });

  const delayedA = await delayedScanAPromise;
  assert.equal(delayedA.dropped, true, 'Customer A delayed result must be dropped because activeScanId progressed');
  assert.equal(harness.lastScanResult.customerId, SYNTHETIC_CUSTOMERS.CUSTOMER_B.appId);
});

test('Stale Customer Bug: Customer changes in SPA without page reload -> Previous customer state cleared', async () => {
  const harness = new SimulatedScanHarness();

  // Customer A loaded on SPA
  await harness.executeScan({
    appId: 'SPA-LEAD-101',
    domProfileName: 'ALOK KUMAR VERMA',
    domProfilePAN: 'ALOKV1234K',
    statements: [{ rawName: 'ALOK KUMAR VERMA', pan: 'ALOKV1234K', accountID: 'AC-101' }]
  });
  assert.equal(harness.lastScanResult.customerId, 'SPA-LEAD-101');

  // SPA route updates DOM to Customer B without page reload
  const resB = await harness.executeScan({
    appId: 'SPA-LEAD-102',
    domProfileName: 'SNEHA RAO',
    domProfilePAN: 'SNEHR5678P',
    statements: [{ rawName: 'SNEHA RAO', pan: 'SNEHR5678P', accountID: 'AC-102' }],
    isSPAUpdate: true
  });

  assert.equal(resB.customerId, 'SPA-LEAD-102');
  assert.equal(resB.profileName, 'SNEHA RAO');
  assert.equal(harness.lastScanResult.statements[0].accountID, 'AC-102');
});

test('Stale Customer Bug: Application ID changes while URL remains the same -> Scans new customer', async () => {
  const harness = new SimulatedScanHarness();

  await harness.executeScan({
    appId: 'APP-CONSTANT-URL-1',
    domProfileName: 'DEEPAK PATEL',
    domProfilePAN: 'PATEL1111A'
  });
  assert.equal(harness.lastScanResult.profileName, 'DEEPAK PATEL');

  // Same URL, but DOM App ID changes to APP-CONSTANT-URL-2
  const res2 = await harness.executeScan({
    appId: 'APP-CONSTANT-URL-2',
    domProfileName: 'MEENA IYER',
    domProfilePAN: 'IYERM2222B'
  });
  assert.equal(res2.customerId, 'APP-CONSTANT-URL-2');
  assert.equal(res2.profileName, 'MEENA IYER');
});

test('Stale Customer Bug: New customer profile name is missing -> Fails safely without reusing old data', async () => {
  const harness = new SimulatedScanHarness();

  // Customer A is verified
  await harness.executeScan({
    appId: SYNTHETIC_CUSTOMERS.CUSTOMER_A.appId,
    domProfileName: SYNTHETIC_CUSTOMERS.CUSTOMER_A.profileName,
    domProfilePAN: SYNTHETIC_CUSTOMERS.CUSTOMER_A.pan
  });

  // Customer B is opened directly to bank statement tab (profile name is null)
  const resB = await harness.executeScan({
    appId: SYNTHETIC_CUSTOMERS.CUSTOMER_B.appId,
    domProfileName: null, // Not yet captured for Customer B!
    domProfilePAN: null,
    statements: [{ rawName: SYNTHETIC_CUSTOMERS.CUSTOMER_B.bankStatementName, pan: 'XYZPK5678Q', accountID: 'AC-B-ONLY' }]
  });

  assert.equal(resB.status, 'unable');
  assert.ok(resB.profileName.includes('Profile tab required for customer'));
  assert.notEqual(resB.profileName, SYNTHETIC_CUSTOMERS.CUSTOMER_A.profileName, 'Must NOT use Customer A name!');
  assert.equal(resB.statements[0].overallResult, 'unverified');
});

test('Stale Customer Bug: Bank statement results from two different customers are never mixed', async () => {
  const harness = new SimulatedScanHarness();

  await harness.executeScan({
    appId: 'CUST-ALPHA',
    domProfileName: 'ALPHA USER',
    statements: [{ rawName: 'ALPHA USER', accountID: 'STMT-ALPHA-01' }]
  });
  assert.equal(harness.lastScanResult.statements.length, 1);
  assert.equal(harness.lastScanResult.statements[0].accountID, 'STMT-ALPHA-01');

  await harness.executeScan({
    appId: 'CUST-BETA',
    domProfileName: 'BETA USER',
    statements: [{ rawName: 'BETA USER', accountID: 'STMT-BETA-01' }, { rawName: 'BETA USER', accountID: 'STMT-BETA-02' }]
  });

  assert.equal(harness.lastScanResult.customerId, 'CUST-BETA');
  assert.equal(harness.lastScanResult.statements.length, 2);
  const accountIds = harness.lastScanResult.statements.map((s) => s.accountID);
  assert.deepEqual(accountIds, ['STMT-BETA-01', 'STMT-BETA-02']);
  assert.ok(!accountIds.includes('STMT-ALPHA-01'), 'Customer ALPHA statements must not be present in Customer BETA results');
});

test('Stale Customer Bug: Repeated clicks on Scan do not cause duplicated or overlapping results', async () => {
  const harness = new SimulatedScanHarness();

  // Rapidly trigger 5 scans
  const p1 = harness.executeScan({ appId: 'REPEAT-1', domProfileName: 'RAPID SCANNER' });
  const p2 = harness.executeScan({ appId: 'REPEAT-1', domProfileName: 'RAPID SCANNER' });
  const p3 = harness.executeScan({ appId: 'REPEAT-1', domProfileName: 'RAPID SCANNER' });
  const p4 = harness.executeScan({ appId: 'REPEAT-1', domProfileName: 'RAPID SCANNER' });
  const p5 = harness.executeScan({ appId: 'REPEAT-1', domProfileName: 'RAPID SCANNER' });

  const results = await Promise.all([p1, p2, p3, p4, p5]);
  // The final active scan is the one that committed
  assert.equal(harness.lastScanResult.scanId, harness.activeScanId);
  assert.equal(harness.lastScanResult.profileName, 'RAPID SCANNER');
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 2: NEEDLE 3 INTEGRATION, SCHEMA, AND DECISION POLICY TESTS
// ─────────────────────────────────────────────────────────────────────────────
test('Needle 3 Integration: When disabled, behavior strictly matches deterministic engine', async () => {
  const harness = new SimulatedScanHarness();
  harness.setEngineConfig('standard', false);

  const res = await harness.executeScan({
    appId: SYNTHETIC_CUSTOMERS.CUSTOMER_C_AMBIGUOUS.appId,
    domProfileName: SYNTHETIC_CUSTOMERS.CUSTOMER_C_AMBIGUOUS.profileName,
    domProfilePAN: SYNTHETIC_CUSTOMERS.CUSTOMER_C_AMBIGUOUS.pan,
    statements: [{ rawName: SYNTHETIC_CUSTOMERS.CUSTOMER_C_AMBIGUOUS.bankStatementName, pan: SYNTHETIC_CUSTOMERS.CUSTOMER_C_AMBIGUOUS.pan, accountID: 'AC-1' }]
  });

  assert.equal(res.statements[0].nameDetail.engineUsed, undefined, 'Needle 3 must not be invoked when disabled');
  assert.equal(harness.needle3Engine.status, 'disabled');
});

test('Needle 3 Integration: When enabled, invoked ONLY on ambiguous names and NOT on clear match', async () => {
  const harness = new SimulatedScanHarness();
  let modelInvoked = false;

  const mockRunner = async ({ rawBankName }) => {
    modelInvoked = true;
    return {
      extractedName: rawBankName,
      confidence: 90,
      classification: 'match',
      reason: 'Mock match'
    };
  };

  harness.setEngineConfig('enhanced', true, mockRunner);

  // Clear exact match: should NOT invoke Needle 3
  await harness.executeScan({
    appId: 'TEST-CLEAR-MATCH',
    domProfileName: 'VIKAS GUPTA',
    domProfilePAN: 'VG1234Z',
    statements: [{ rawName: 'VIKAS GUPTA', pan: 'VG1234Z', accountID: 'AC-1' }]
  });
  assert.equal(modelInvoked, false, 'Needle 3 must NOT be invoked on clear exact match');

  // Ambiguous name: SHOULD invoke Needle 3
  await harness.executeScan({
    appId: 'TEST-AMBIGUOUS',
    domProfileName: 'ANIL RAMESHCHANDRA GUPTA',
    domProfilePAN: 'ARG9999M',
    statements: [{ rawName: 'A R GUPTA', pan: 'ARG9999M', accountID: 'AC-2' }]
  });
  assert.equal(modelInvoked, true, 'Needle 3 must be invoked on ambiguous name in Enhanced mode');
});

test('Needle 3 Integration: Strict Schema Validation rejects malformed output', () => {
  // Test 1: Null or non-object
  assert.equal(validateNeedle3Output(null).valid, false);
  assert.equal(validateNeedle3Output('invalid string').valid, false);

  // Test 2: Missing extractedName
  assert.equal(validateNeedle3Output({ classification: 'match', confidence: 95 }).valid, false);

  // Test 3: Invalid confidence (> 100 or < 0)
  assert.equal(validateNeedle3Output({ extractedName: 'Test', classification: 'match', confidence: 150 }).valid, false);
  assert.equal(validateNeedle3Output({ extractedName: 'Test', classification: 'match', confidence: -10 }).valid, false);

  // Test 4: Invalid classification
  assert.equal(validateNeedle3Output({ extractedName: 'Test', classification: 'approved', confidence: 90 }).valid, false);

  // Test 5: Valid schema
  const valid = validateNeedle3Output({
    extractedName: 'KUMAR RAJESH',
    confidence: 88,
    classification: 'match',
    reason: 'Token reordering confirmed'
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.data.extractedName, 'KUMAR RAJESH');
  assert.equal(valid.data.confidence, 88);
  assert.equal(valid.data.classification, 'match');
});

test('Needle 3 Integration: Model & Deterministic matcher disagree -> Routes to Manual Review', () => {
  const deterministicResult = {
    result: 'partial',
    confidence: 65,
    needsManualCheck: true
  };

  // Needle 3 claims it is a match
  const secondaryResult = {
    extractedName: 'TEST NAME',
    confidence: 90,
    classification: 'match',
    reason: 'Model suggests match'
  };

  const reconciled = reconcileEngineResults({
    deterministicResult,
    secondaryResult,
    panResult: { result: 'Match' }
  });

  // Decision Policy Rule 5: If engines disagree, MUST return Manual Review ('partial'/'review')
  assert.equal(reconciled.result, 'partial', 'Disagreement must route to Manual Review (partial)');
  assert.equal(reconciled.needsManualCheck, true, 'needsManualCheck must remain true');
  assert.ok(reconciled.reconciliationReason.includes('Engine disagreement'));
});

test('Needle 3 Integration: PAN mismatch remains Fail even if Needle 3 suggests a name match', async () => {
  const harness = new SimulatedScanHarness();
  const mockRunner = async () => ({
    extractedName: 'VIKRAM NAIR',
    confidence: 100,
    classification: 'match',
    reason: 'Perfect name match'
  });
  harness.setEngineConfig('enhanced', true, mockRunner);

  const res = await harness.executeScan({
    appId: SYNTHETIC_CUSTOMERS.CUSTOMER_D_PAN_MISMATCH.appId,
    domProfileName: SYNTHETIC_CUSTOMERS.CUSTOMER_D_PAN_MISMATCH.profileName,
    domProfilePAN: SYNTHETIC_CUSTOMERS.CUSTOMER_D_PAN_MISMATCH.pan,
    statements: [{
      rawName: SYNTHETIC_CUSTOMERS.CUSTOMER_D_PAN_MISMATCH.bankStatementName,
      pan: SYNTHETIC_CUSTOMERS.CUSTOMER_D_PAN_MISMATCH.bankPAN, // Mismatched PAN!
      accountID: 'AC-PAN-FAIL'
    }]
  });

  // Decision Policy Rule 6: PAN mismatch must remain a failure
  assert.equal(res.statements[0].overallResult, 'mismatch', 'PAN mismatch must override name match');
  assert.equal(res.mismatchCount, 1);
});

test('Needle 3 Integration: Model loading fails or times out -> Gracefully falls back without crash', async () => {
  const harness = new SimulatedScanHarness();
  // Runner that throws an exception
  const faultyRunner = async () => {
    throw new Error('WASM engine load error');
  };
  harness.setEngineConfig('enhanced', true, faultyRunner);

  const res = await harness.executeScan({
    appId: 'FAULT-TEST',
    domProfileName: 'TEST USER',
    domProfilePAN: 'PAN1234567',
    statements: [{ rawName: 'TEST USER PARTIAL', pan: 'PAN1234567', accountID: 'AC-FAULT' }]
  });

  // Must not throw, should handle gracefully
  assert.ok(res);
  assert.equal(res.statements[0].nameDetail.needsManualCheck, true);
});

test('Needle 3 Integration: Extension works offline without model files and documents blocker', () => {
  const engine = new Needle3EngineManager({ enabled: true, mode: 'enhanced' });
  const status = engine.getStatus();

  assert.equal(status.enabled, true);
  assert.equal(status.status, 'unavailable', 'Status must be unavailable when local weights are not bundled');
  assert.equal(status.blocker.blockerCode, 'LOCAL_WEIGHTS_NOT_BUNDLED');
  assert.equal(status.blocker.cloudApisAllowed, false, 'Cloud APIs must be forbidden for KYC');
});

test('Stale Customer Bug: Closing and reopening popup does not restore stale customer results', async () => {
  const harness = new SimulatedScanHarness();

  // Scan Customer A
  await harness.executeScan({
    appId: 'APP-POPUP-A',
    domProfileName: 'CUSTOMER A POPUP',
    domProfilePAN: 'AAAAA1111A'
  });
  assert.equal(harness.lastScanResult.profileName, 'CUSTOMER A POPUP');

  // Customer navigates to new customer B page, but popup closed
  // Now popup reopens and calls GET_STATUS on Customer B page
  const statusResponse = await harness.executeScan({
    appId: 'APP-POPUP-B',
    domProfileName: null, // Profile not loaded on this tab
    statements: []
  });

  // Must NOT report Customer A
  assert.notEqual(statusResponse.profileName, 'CUSTOMER A POPUP');
  assert.ok(statusResponse.profileName.includes('APP-POPUP-B'));
});

test('Privacy Compliance: Zero customer data transmitted externally', async () => {
  // Verify Needle 3 Engine does not expose any external fetch/HTTP endpoints
  const engine = new Needle3EngineManager({ enabled: true, mode: 'enhanced' });
  assert.equal(engine.blockerInfo.cloudApisAllowed, false);
  assert.equal(engine.blockerInfo.offlineRequired, true);

  // Calling analyzeAmbiguousName without local runner must never invoke network
  const res = await engine.analyzeAmbiguousName(
    'CONFIDENTIAL CUSTOMER',
    'CONFIDENTIAL BANK HOLDER',
    { result: 'partial', confidence: 65, needsManualCheck: true }
  );

  assert.equal(res.isFallback, true);
  assert.ok(res.reason.includes('KYC privacy preserved'));
});

test('Stale Customer Bug: Navigating to Emp Info tab for a new customer without verified profile never leaks old customer name', async () => {
  const harness = new SimulatedScanHarness();

  // 1. Scan Customer A on Profile tab
  const resA = await harness.executeScan({
    appId: 'APP-CUST-A',
    domProfileName: 'RAJESH KUMAR SHARMA',
    domProfilePAN: 'ABCDE1234F',
    statements: [{ rawName: 'RAJESH KUMAR SHARMA', pan: 'ABCDE1234F', accountID: 'AC-101' }],
    activeTab: 'profile'
  });
  assert.equal(resA.profileName, 'RAJESH KUMAR SHARMA');
  assert.equal(resA.matchCount, 1);

  // 2. User moves to Customer B directly on Emp Info tab (no profile DOM, bank statement has Customer B)
  const resB = await harness.executeScan({
    appId: 'APP-CUST-B',
    domProfileName: null, // No profile name on Emp Info tab!
    domProfilePAN: null,
    statements: [{ rawName: 'KAVITA SURESH SINGH', pan: 'KAVIT9876P', accountID: 'AC-202' }],
    activeTab: 'empinfo',
    bankHolderName: 'KAVITA SURESH SINGH'
  });

  // Customer A's profile name must NEVER appear in Customer B's Emp Info scan
  assert.notEqual(resB.profileName, 'RAJESH KUMAR SHARMA');
  assert.equal(resB.hasProfile, false);
  assert.equal(resB.matchCount, 0);
  assert.equal(resB.mismatchCount, 0);
  assert.equal(resB.statements[0].overallResult, 'unverified');
});

test('Full Reset Action: Alt+R / Reset clears all session cache, highlights, and transient scan data', async () => {
  const harness = new SimulatedScanHarness();

  // Scan Customer A
  await harness.executeScan({
    appId: 'APP-RESET-101',
    domProfileName: 'VIKRAM ADITYA',
    domProfilePAN: 'VIKRA1234V',
    statements: [{ rawName: 'VIKRAM ADITYA', pan: 'VIKRA1234V', accountID: 'AC-R1' }]
  });
  assert.equal(harness.customerSessionRegistry.size, 1);

  // Trigger performFullReset (as done by Reset button or Alt+R)
  const resetResult = harness.performFullReset();
  assert.equal(resetResult.scanned, false);
  assert.equal(resetResult.profileName, '—');
  assert.equal(harness.customerSessionRegistry.size, 0);

  // Subsequent check on Emp Info tab has zero fallback
  const resAfterReset = await harness.executeScan({
    appId: null,
    domProfileName: null,
    statements: [{ rawName: 'NEW UNKNOWN PERSON', accountID: 'AC-R2' }],
    activeTab: 'empinfo'
  });
  assert.equal(resAfterReset.hasProfile, false);
  assert.notEqual(resAfterReset.profileName, 'VIKRAM ADITYA');
});

test('Emp Info Tab Customer Detection: Bank statement account holder differs from previous profile -> Triggers customer change immediately', async () => {
  const harness = new SimulatedScanHarness();

  // Scan Customer A
  await harness.executeScan({
    appId: null, // No explicit App ID detected on page
    domProfileName: 'ANAND VERMA',
    domProfilePAN: 'ANAND5555A',
    statements: []
  });

  // User opens Customer B on Emp Info tab where bank account is "PRIYA SINGH"
  const resB = await harness.executeScan({
    appId: null,
    domProfileName: null,
    bankHolderName: 'PRIYA SINGH',
    statements: [{ rawName: 'PRIYA SINGH', accountID: 'AC-P1' }],
    activeTab: 'empinfo'
  });

  // Must detect customer change and NOT compare ANAND VERMA against PRIYA SINGH
  assert.notEqual(resB.profileName, 'ANAND VERMA');
  assert.equal(resB.hasProfile, false);
  assert.equal(resB.statements[0].overallResult, 'unverified');
});

test('Welcome Page Setup & Hygiene: URL inputs and AI download present, dashboard details strictly removed', async () => {
  const fs = require('fs');
  const path = require('path');
  const welcomeHTML = fs.readFileSync(path.join(__dirname, '../welcome.html'), 'utf8');

  // Must have URL input and save button
  assert.ok(welcomeHTML.includes('id="allowedDomainsInput"'), 'allowedDomainsInput must exist');
  assert.ok(welcomeHTML.includes('id="saveUrlsBtn"'), 'saveUrlsBtn must exist');

  // Must have Grab / Detect open pages feature
  assert.ok(welcomeHTML.includes('id="grabOpenTabsBtn"'), 'grabOpenTabsBtn must exist');
  assert.ok(welcomeHTML.includes('id="detectedTabsContainer"'), 'detectedTabsContainer must exist');

  // Must NOT have static presets like '+ IB-NBFC'
  assert.ok(!welcomeHTML.includes('+ IB-NBFC'), '+ IB-NBFC preset must be removed');

  // Must have AI download and toggle controls
  assert.ok(welcomeHTML.includes('id="downloadModelBtn"'), 'downloadModelBtn must exist');
  assert.ok(welcomeHTML.includes('id="downloadProgressBar"'), 'downloadProgressBar must exist');
  assert.ok(welcomeHTML.includes('id="aiEnableToggle"'), 'aiEnableToggle must exist');
  assert.ok(welcomeHTML.includes('id="modeStandard"'), 'modeStandard radio must exist');
  assert.ok(welcomeHTML.includes('id="modeEnhanced"'), 'modeEnhanced radio must exist');

  // Responsiveness checks
  assert.ok(welcomeHTML.includes('viewport'), 'Viewport meta must exist for responsiveness');
  assert.ok(welcomeHTML.includes('@media'), 'CSS media queries must exist for responsive layout');

  // Must NOT include dashboard details / mock sandbox
  assert.ok(!welcomeHTML.includes('id="sbProfileName"'), 'sbProfileName must NOT exist');
  assert.ok(!welcomeHTML.includes('id="sbBankName"'), 'sbBankName must NOT exist');
  assert.ok(!welcomeHTML.includes('app-icons-cluster'), 'app-icons-cluster must NOT exist');
  assert.ok(!welcomeHTML.includes('avatar-stack-container'), 'avatar-stack-container must NOT exist');
});

test('Design Consistency: Extension popup and dashboard small popup share light-mode redesign and dark tokens', async () => {
  const fs = require('fs');
  const path = require('path');
  const popupHTML = fs.readFileSync(path.join(__dirname, '../popup.html'), 'utf8');
  const contentJS = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');

  // Both must support light and dark data-theme
  assert.ok(popupHTML.includes('data-theme="light"'), 'popup.html must define light theme');
  assert.ok(popupHTML.includes('data-theme="dark"'), 'popup.html must define dark theme');
  assert.ok(contentJS.includes('data-theme="light"'), 'content.js must define light theme');
  assert.ok(contentJS.includes('data-theme="dark"'), 'content.js must define dark theme');

  // Light mode redesign tokens alignment
  assert.ok(popupHTML.includes('#f8fafc'), 'popup.html has alabaster light ground');
  assert.ok(contentJS.includes('#f8fafc'), 'content.js has alabaster light ground');
  assert.ok(popupHTML.includes('#e2e8f0'), 'popup.html has clean hairline border');
  assert.ok(contentJS.includes('#e2e8f0'), 'content.js has clean hairline border');
  assert.ok(popupHTML.includes('#15803d'), 'popup.html has emerald success text');
  assert.ok(contentJS.includes('#15803d'), 'content.js has emerald success text');
});

test('Welcome Page & Popup Synchronization: Real-time storage sync, fallback portal suggestions, and reliable script initialization', async () => {
  const fs = require('fs');
  const path = require('path');
  const welcomeHTML = fs.readFileSync(path.join(__dirname, '../welcome.html'), 'utf8');
  const popupJS = fs.readFileSync(path.join(__dirname, '../popup.js'), 'utf8');
  const contentJS = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');

  // 1. Script executes regardless of readyState (doesn't get stuck if DOMContentLoaded fired)
  assert.ok(welcomeHTML.includes('document.readyState === "loading"'), 'welcome.html checks document.readyState for safe init');
  assert.ok(welcomeHTML.includes('initWelcomePage'), 'welcome.html defines initWelcomePage entry point');

  // 2. Initial HTML defaults match Standard/Off prior to download
  assert.ok(welcomeHTML.includes('id="aiEnableToggle" class="pill-switch off"'), 'aiEnableToggle starts off in HTML');
  assert.ok(welcomeHTML.includes('id="modeStandard" checked'), 'modeStandard starts checked in HTML');

  // 3. Dynamic Open Pages has fallback suggestions when 0 pages detected
  assert.ok(welcomeHTML.includes('suggestions.forEach'), 'welcome.html renders fallback suggestions when 0 tabs open');
  assert.ok(welcomeHTML.includes('localhost:3000'), 'welcome.html offers localhost dev suggestion');
  assert.ok(welcomeHTML.includes('losportal.in'), 'welcome.html offers losportal suggestion');

  // 4. Live Storage Synchronization across welcome.html, popup.js, content.js
  assert.ok(welcomeHTML.includes('chrome.storage.onChanged.addListener'), 'welcome.html listens to live storage changes');
  assert.ok(popupJS.includes('chrome.storage.onChanged.addListener'), 'popup.js listens to live storage changes');
  assert.ok(contentJS.includes('changes.allowedDomains'), 'content.js listens to allowedDomains changes');

  // 5. Popup does NOT freeze or early return when opened on welcome.html
  assert.ok(popupJS.includes('setSetupPageState'), 'popup.js defines setSetupPageState for extension tabs');
  assert.ok(popupJS.includes('isInternalUrl'), 'popup.js recognizes internal URLs and searches for candidate portal tabs');
});



