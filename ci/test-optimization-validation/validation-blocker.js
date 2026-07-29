'use strict'

/**
 * Builds an incomplete-validation error with a customer-safe recovery action.
 *
 * @param {string} message blocker diagnosis
 * @param {object} input blocker details
 * @param {string} input.kind stable blocker kind
 * @param {string} input.recommendation safe recovery action
 * @param {boolean} [input.suppressReport] avoid modifying artifacts owned by another process
 * @returns {Error} typed validation blocker
 */
function createValidationBlocker (message, { kind, recommendation, suppressReport = false }) {
  const error = new Error(message)
  error.validationBlocker = { kind, recommendation }
  error.validationExitCode = 2
  error.suppressReport = suppressReport
  return error
}

/**
 * Returns report evidence for a typed validation blocker.
 *
 * @param {unknown} error possible validation blocker
 * @returns {object|undefined} blocker evidence
 */
function getValidationBlockerEvidence (error) {
  if (!error?.validationBlocker) return
  return {
    blockerKind: error.validationBlocker.kind,
    domain: 'validator_state',
    recommendation: error.validationBlocker.recommendation,
    validationIncomplete: true,
  }
}

module.exports = { createValidationBlocker, getValidationBlockerEvidence }
