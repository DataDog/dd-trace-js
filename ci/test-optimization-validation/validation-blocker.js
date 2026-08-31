'use strict'

function createValidationBlocker (message, { kind, recommendation, suppressReport = false }) {
  const error = new Error(message)
  error.validationBlocker = { kind, recommendation }
  error.validationExitCode = 2
  error.suppressReport = suppressReport
  return error
}

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
