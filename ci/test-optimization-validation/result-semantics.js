'use strict'

const { BLOCKER_CATEGORIES, getBlockerDomain } = require('./blocker-category')

function annotateResults (results) {
  return results.map(result => ({
    ...result,
    blockerCategory: result.evidence?.blockerCategory,
    conclusion: result.evidence?.conclusion || getConclusion(result),
    domain: result.evidence?.domain || getDomain(result),
    evidenceStrength: result.evidence?.evidenceStrength || getEvidenceStrength(result),
  }))
}

function getExecutionStatus (results) {
  if (results.some(isValidatorError)) return 'validator_error'

  const conclusionResults = results.filter(result => {
    const runLevelDomains = [
      'execution_environment',
      'local_runtime',
      'project_setup',
      'unsupported_version',
      'validator_adapter',
    ]
    return result.scenario !== 'all' || runLevelDomains.includes(result.domain)
  })
  const allIncomplete = conclusionResults.length > 0 && conclusionResults.every(result => {
    return result.domain === 'execution_environment' || ['not_checked', 'incomplete'].includes(result.conclusion)
  })
  if (!allIncomplete) return 'completed'
  const categories = new Set(conclusionResults.map(result => result.blockerCategory).filter(Boolean))
  if (categories.has(BLOCKER_CATEGORIES.EXECUTION_ENVIRONMENT_BLOCKED)) return 'execution_environment_blocked'
  if (categories.has(BLOCKER_CATEGORIES.PROJECT_SETUP_REQUIRED)) return 'project_setup_required'
  if (categories.has(BLOCKER_CATEGORIES.UNSUPPORTED_VERSION)) return 'unsupported_version'
  if (categories.has(BLOCKER_CATEGORIES.VALIDATOR_LIMITATION)) return 'validator_limitation'
  if (categories.has(BLOCKER_CATEGORIES.CLEAN_TEST_FAILED)) return 'clean_test_failed'
  if (conclusionResults.some(result => ['execution_environment', 'local_runtime'].includes(result.domain))) {
    return 'execution_environment_blocked'
  }
  if (conclusionResults.some(result => result.domain === 'project_setup')) return 'project_setup_required'
  return 'incomplete'
}

function getValidatorExitCode (results, executionStatus) {
  if (executionStatus === 'validator_error') return 3
  if (results.some(result => result.status === 'fail' && result.evidenceStrength.startsWith('confirmed_'))) return 1
  const incomplete = results.some(result => {
    return ['configured_propagation_unverified', 'incomplete', 'not_checked'].includes(result.conclusion)
  })
  if (executionStatus !== 'completed' || incomplete || !results.some(result => result.scenario !== 'all')) return 2
  return 0
}

function getValidationCoverage (results) {
  return results.some(result => result.conclusion === 'not_checked' ||
    result.evidence?.validationIncomplete ||
    result.evidence?.manifestIncomplete)
    ? 'partial'
    : 'complete'
}

function getConclusion (result) {
  if (result.evidence?.validationIncomplete || result.evidence?.manifestIncomplete) return 'incomplete'
  if (result.status === 'pass') return 'confirmed_working'
  if (result.status === 'fail') {
    return result.scenario === 'ci-wiring' ? 'confirmed_misconfigured' : 'confirmed_not_working'
  }
  if (result.status === 'skip') {
    return result.evidence?.featureEligibility?.eligible === false ? 'not_checked' : 'not_eligible'
  }
  return 'incomplete'
}

function getDomain (result) {
  const blockerDomain = getBlockerDomain(result.evidence?.blockerCategory)
  if (blockerDomain) return blockerDomain
  if (result.evidence?.blockedByProjectSetup) return 'project_setup'
  if (result.evidence?.localRuntimeBlocked) return 'local_runtime'
  if (result.evidence?.blockedByExecutionEnvironment) return 'execution_environment'
  if (result.scenario === 'ci-wiring') return 'ci_configuration'
  if (result.evidence?.staticDiagnosis) return 'project_setup'
  if (result.status === 'blocked') return 'execution_environment'
  if (result.evidence?.validatorAdapterUnavailable || result.evidence?.manifestIncomplete ||
    result.frameworkId === 'validator' || result.frameworkId === 'validation-cleanup') return 'validator_adapter'
  return 'test_optimization'
}

function getEvidenceStrength (result) {
  if (result.status === 'pass' || result.status === 'fail') {
    return result.evidence?.staticDiagnosis ? 'confirmed_static' : 'confirmed_runtime'
  }
  if (result.status === 'blocked') return 'confirmed_runtime'
  return result.evidence?.staticDiagnosis ? 'inferred_static' : 'unknown'
}

function isValidatorError (result) {
  return result.evidence?.validationOrchestrationFailed === true ||
    result.frameworkId === 'validator' ||
    result.frameworkId === 'validation-cleanup'
}

module.exports = { annotateResults, getExecutionStatus, getValidationCoverage, getValidatorExitCode }
