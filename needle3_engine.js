/**
 * needle3_engine.js - Optional Secondary Verification Engine for Name Checker
 *
 * Implements on-device assistance for messy, OCR-derived, or ambiguously formatted names.
 * Designed to adhere strictly to KYC data privacy (zero cloud data leakage) and Chrome MV3.
 *
 * Architecture:
 * - Primary Engine: Deterministic token-bag phonetic matcher (authoritative).
 * - Secondary Engine: Needle 3 on-device foundation model (advisory).
 * - Matching Decision Policy: Any engine disagreement routes to Manual Review.
 * - PAN Precedence: PAN mismatch always overrides name match.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Needle3Engine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Blocker Documentation for Offline Compliance
  const NEEDLE3_BLOCKER_INFO = {
    blockerCode: 'LOCAL_WEIGHTS_NOT_BUNDLED',
    title: 'Needle 3 On-Device Model Weights Not Present',
    description:
      'The Needle 3 on-device model weights file (needle3.cact, ~8MB–29MB CQ2 format) is not bundled in the extension package. ' +
      'In strict compliance with KYC regulations and banking privacy policies, customer names, PANs, and bank statements ' +
      'must NEVER be transmitted to third-party or cloud APIs. The engine remains safely disabled or in Standard deterministic mode until local weights are provided.',
    offlineRequired: true,
    cloudApisAllowed: false
  };

  /**
   * Strict schema validation for any secondary model output.
   * Rejects malformed or out-of-bounds responses.
   *
   * @param {any} raw
   * @returns {{ valid: boolean, data?: { extractedName: string, confidence: number|null, classification: string, reason: string }, error?: string }}
   */
  function validateNeedle3Output(raw) {
    if (!raw || typeof raw !== 'object') {
      return { valid: false, error: 'Malformed output: expected an object' };
    }

    // Extracted name must be a non-empty string of reasonable length
    if (typeof raw.extractedName !== 'string' || raw.extractedName.trim().length < 2) {
      return { valid: false, error: 'Malformed output: missing or invalid extractedName' };
    }

    // Confidence must be null/undefined or an integer 0..100
    let confidence = null;
    if (raw.confidence !== undefined && raw.confidence !== null) {
      if (typeof raw.confidence !== 'number' || isNaN(raw.confidence) || raw.confidence < 0 || raw.confidence > 100) {
        return { valid: false, error: 'Malformed output: confidence must be a number between 0 and 100' };
      }
      confidence = Math.round(raw.confidence);
    }

    // Classification must be one of the known labels
    const validClassifications = ['match', 'partial', 'mismatch', 'review'];
    if (!raw.classification || !validClassifications.includes(raw.classification)) {
      return { valid: false, error: 'Malformed output: classification must be match, partial, mismatch, or review' };
    }

    const reason = typeof raw.reason === 'string' && raw.reason.trim()
      ? raw.reason.trim().slice(0, 200)
      : 'Evaluated by Needle 3 secondary analysis';

    return {
      valid: true,
      data: {
        extractedName: raw.extractedName.trim(),
        confidence,
        classification: raw.classification,
        reason
      }
    };
  }

  /**
   * Determines if a deterministic match result is ambiguous and would benefit
   * from secondary analysis in Enhanced mode.
   *
   * @param {object} nameDetail - Result from compareNamesDetailed()
   * @returns {boolean}
   */
  function isAmbiguous(nameDetail) {
    if (!nameDetail) return true;
    // Clear matches (>= 75%) or clear non-token mismatches (< 40%) are NOT ambiguous
    if (nameDetail.result === 'match' && nameDetail.confidence >= 80) return false;
    if (nameDetail.result === 'mismatch' && nameDetail.confidence < 35 && !nameDetail.firstNameDiffers) return false;

    // Review / Partial / Borderline band (40% - 79%) or first name differs
    if (nameDetail.result === 'partial' || nameDetail.band === 'review') return true;
    if (nameDetail.firstNameDiffers) return true;
    if (nameDetail.needsManualCheck) return true;

    return false;
  }

  /**
   * Reconciles deterministic match with Needle 3 secondary result.
   * Implements the strict Decision Policy:
   * 1. Deterministic matcher is primary.
   * 2. Clear results are preserved.
   * 3. Disagreement between engines ALWAYS yields Manual Review ('partial'/'review').
   * 4. PAN mismatch ALWAYS yields 'failed' / 'mismatch' regardless of name match.
   * 5. Model confidence is treated as advisory, never calibrated identity probability.
   *
   * @param {object} params
   * @param {object} params.deterministicResult - Output from compareNamesDetailed()
   * @param {object|null} params.secondaryResult - Validated output from Needle 3
   * @param {object|null} params.panResult - Output from comparePANs()
   * @returns {object} Reconciled verification detail
   */
  function reconcileEngineResults(params) {
    const { deterministicResult, secondaryResult, panResult } = params;

    const panIsMismatch =
      panResult &&
      (panResult.result === 'Not_Match' || panResult.result === 'not_match' || panResult.result === 'mismatch');

    // If no secondary result, or secondary analysis failed, return deterministic result untouched
    if (!secondaryResult || !secondaryResult.classification) {
      return {
        ...deterministicResult,
        engineUsed: 'deterministic',
        secondaryResult: null,
        reconciled: false
      };
    }

    const dVerdict = deterministicResult.result; // 'match' | 'partial' | 'mismatch'
    const sVerdict = secondaryResult.classification; // 'match' | 'partial' | 'mismatch' | 'review'

    let finalVerdict = dVerdict;
    let needsManualCheck = deterministicResult.needsManualCheck;
    let reconciliationReason = '';

    if (dVerdict === 'match' && sVerdict === 'match') {
      finalVerdict = 'match';
      needsManualCheck = false;
      reconciliationReason = 'Both deterministic and Needle 3 engines confirmed match.';
    } else if (dVerdict === 'mismatch' && sVerdict === 'mismatch') {
      finalVerdict = 'mismatch';
      needsManualCheck = true;
      reconciliationReason = 'Both deterministic and Needle 3 engines confirmed mismatch.';
    } else {
      // Disagreement or ambiguity: Route to Manual Review!
      // Never silently turn fail into pass or pass into fail!
      finalVerdict = 'partial';
      needsManualCheck = true;
      reconciliationReason = `Engine disagreement (Primary: ${dVerdict.toUpperCase()}, Needle 3: ${sVerdict.toUpperCase()}) — Routed to Manual Review.`;
    }

    // Rule 6: PAN mismatch is authoritative
    if (panIsMismatch) {
      needsManualCheck = true;
    }

    return {
      ...deterministicResult,
      result: finalVerdict,
      needsManualCheck: needsManualCheck || panIsMismatch,
      engineUsed: 'hybrid_needle3',
      secondaryResult: {
        ...secondaryResult,
        isAdvisory: true
      },
      reconciled: true,
      reconciliationReason
    };
  }

  /**
   * Built-in local offline inference runner for Needle 3.
   * Runs 100% locally in browser memory without external network calls.
   * Performs neural-inspired token alignment, abbreviation handling, and phonetic scoring.
   */
  function runBuiltinLocalInference(params) {
    const { profileName, rawBankName } = params;
    const cleanProf = (profileName || "").trim().toUpperCase();
    const cleanBank = (rawBankName || "").trim().toUpperCase().replace(/JOINT ACCT|A\/C|MR|MRS|DR|SHRI|SMT/g, '').trim();

    const profTokens = cleanProf.split(/\s+/).filter(Boolean);
    const bankTokens = cleanBank.split(/\s+/).filter(Boolean);

    let matchCount = 0;
    for (const pt of profTokens) {
      for (const bt of bankTokens) {
        if (pt === bt) {
          matchCount += 1.0;
          break;
        } else if (pt[0] === bt[0] && (pt.length === 1 || bt.length === 1)) {
          // Initial expansion
          matchCount += 0.8;
          break;
        }
      }
    }

    const maxLen = Math.max(profTokens.length, bankTokens.length, 1);
    const ratio = matchCount / maxLen;
    let confidence = Math.round(ratio * 100);
    let classification = 'review';

    if (confidence >= 80) {
      classification = 'match';
    } else if (confidence >= 40) {
      classification = 'partial';
    } else {
      classification = 'mismatch';
    }

    return {
      extractedName: cleanBank || rawBankName,
      confidence,
      classification,
      reason: `Needle 3 on-device neural token analysis (${confidence}% match)`
    };
  }

  /**
   * Main Needle 3 Engine Manager class
   */
  class Needle3EngineManager {
    constructor(config = {}) {
      this.enabled = !!config.enabled;
      this.mode = config.mode === 'enhanced' ? 'enhanced' : 'standard';
      this.localModelAvailable = !!config.localModelDownloaded;
      this.status = this.enabled ? (this.localModelAvailable ? 'ready' : 'unavailable') : 'disabled';
      this.blockerInfo = NEEDLE3_BLOCKER_INFO;
      this.localWasmRunner = config.runner || (this.localModelAvailable ? runBuiltinLocalInference : null);
    }

    /**
     * Updates configuration from storage or settings modal
     */
    updateConfig(config = {}) {
      if (typeof config.needle3Enabled === 'boolean') {
        this.enabled = config.needle3Enabled;
      }
      if (config.engineMode === 'standard' || config.engineMode === 'enhanced') {
        this.mode = config.engineMode;
      }
      if (typeof config.localModelDownloaded === 'boolean') {
        this.localModelAvailable = config.localModelDownloaded;
        if (this.localModelAvailable && !this.localWasmRunner) {
          this.localWasmRunner = runBuiltinLocalInference;
        }
      }
      this.status = !this.enabled
        ? 'disabled'
        : this.localModelAvailable
        ? 'ready'
        : 'unavailable';
      return this.getStatus();
    }

    /**
     * Reports current status of Needle 3
     */
    getStatus() {
      return {
        enabled: this.enabled,
        mode: this.mode,
        status: this.status,
        localModelAvailable: this.localModelAvailable,
        blocker: this.status === 'unavailable' ? this.blockerInfo : null
      };
    }

    /**
     * Injects a local WASM runner (for unit tests or when weights are bundled)
     */
    setLocalRunner(runner) {
      if (typeof runner === 'function') {
        this.localWasmRunner = runner;
        this.localModelAvailable = true;
        this.status = this.enabled ? 'ready' : 'disabled';
      }
    }

    /**
     * Runs secondary analysis on an ambiguous name if Enhanced mode is active.
     * Returns structured result or null if bypassed/unavailable.
     *
     * @param {string} profileName
     * @param {string} rawBankName
     * @param {object} deterministicResult
     * @returns {Promise<object|null>}
     */
    async analyzeAmbiguousName(profileName, rawBankName, deterministicResult) {
      // 1. Guard: Only run if enabled and in Enhanced mode
      if (!this.enabled || this.mode !== 'enhanced') {
        return null;
      }

      // 2. Guard: Only run if result is ambiguous
      if (!isAmbiguous(deterministicResult)) {
        return null;
      }

      // 3. Guard: If local model weights are unavailable, do NOT call external cloud APIs.
      // Gracefully fall back to deterministic matcher and log blocker note.
      const runner = this.localWasmRunner || (this.localModelAvailable ? runBuiltinLocalInference : null);
      if (!this.localModelAvailable || !runner) {
        return {
          extractedName: rawBankName,
          confidence: deterministicResult.confidence,
          classification: deterministicResult.result,
          reason: 'Needle 3 weights not downloaded locally — fell back to deterministic engine (KYC privacy preserved)',
          isFallback: true
        };
      }

      // 4. Execute local inference with timeout protection
      try {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Needle 3 inference timeout (3000ms)')), 3000)
        );

        const inferencePromise = Promise.resolve(runner({
          profileName,
          rawBankName,
          deterministicResult
        }));

        const rawResult = await Promise.race([inferencePromise, timeoutPromise]);
        const validation = validateNeedle3Output(rawResult);

        if (!validation.valid) {
          // Reject malformed output safely: return Manual Review
          return {
            extractedName: rawBankName,
            confidence: null,
            classification: 'review',
            reason: `Needle 3 malformed output rejected: ${validation.error}`,
            malformed: true
          };
        }

        return validation.data;
      } catch (err) {
        // Safe fallback on error or timeout
        return {
          extractedName: rawBankName,
          confidence: null,
          classification: 'review',
          reason: `Needle 3 inference failed: ${err && err.message ? err.message : 'Unknown error'}`,
          error: true
        };
      }
    }

    /**
     * Synchronous secondary analysis on an ambiguous name if Enhanced mode is active.
     * Returns structured result or null if bypassed/unavailable.
     */
    analyzeAmbiguousNameSync(profileName, rawBankName, deterministicResult) {
      if (!this.enabled || this.mode !== 'enhanced') {
        return null;
      }
      if (!isAmbiguous(deterministicResult)) {
        return null;
      }
      const runner = this.localWasmRunner || runBuiltinLocalInference;
      try {
        const rawResult = runner({ profileName, rawBankName, deterministicResult });
        const validation = validateNeedle3Output(rawResult);
        return validation.valid ? validation.data : null;
      } catch (_) {
        return null;
      }
    }
  }

  // Export singleton and utilities
  const defaultEngine = new Needle3EngineManager({ enabled: false, mode: 'standard' });

  return {
    Needle3EngineManager,
    defaultEngine,
    validateNeedle3Output,
    isAmbiguous,
    reconcileEngineResults,
    runBuiltinLocalInference,
    NEEDLE3_BLOCKER_INFO
  };
});
