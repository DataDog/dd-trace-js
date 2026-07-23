'use strict'

function annotateResults (results) {
  return results.map(result => ({
    ...result,
    conclusion: result.evidence?.conclusion || getConclusion(result),
    domain: result.evidence?.domain || getDomain(result),
    evidenceStrength: result.evidence?.evidenceStrength || getEvidenceStrength(result),
  }))
}

function getExecutionStatus (results) {
  if (results.some(isValidatorError)) return 'validator_error'

  const conclusionResults = results.filter(result => {
    return result.scenario !== 'all' || ['execution_environment', 'project_setup'].includes(result.domain)
  })
  const allIncomplete = conclusionResults.length > 0 && conclusionResults.every(result => {
    return result.domain === 'execution_environment' || ['not_checked', 'incomplete'].includes(result.conclusion)
  })
  if (!allIncomplete) return 'completed'
  if (conclusionResults.some(result => result.domain === 'execution_environment')) return 'blocked'
  if (conclusionResults.some(result => result.domain === 'project_setup')) return 'project_setup_required'
  return 'completed'
}

function getValidatorExitCode (results, executionStatus) {
  if (executionStatus === 'validator_error') return 3
  if (results.some(result => result.status === 'fail' && result.evidenceStrength.startsWith('confirmed_'))) return 1
  const incomplete = results.some(result => {
    return ['configured_propagation_unverified', 'incomplete'].includes(result.conclusion)
  })
  if (executionStatus !== 'completed' || incomplete || !results.some(result => result.scenario !== 'all')) return 2
  return 0
}

function getConclusion (result) {
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
  if (result.evidence?.blockedByProjectSetup) return 'project_setup'
  if (result.evidence?.blockedByExecutionEnvironment) return 'execution_environment'
  if (result.scenario === 'ci-wiring') return 'ci_configuration'
  if (result.evidence?.commandFailure || result.evidence?.staticDiagnosis) return 'project_setup'
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

module.exports = { annotateResults, getExecutionStatus, getValidatorExitCode }
