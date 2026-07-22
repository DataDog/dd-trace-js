'use strict'

const assert = require('node:assert/strict')

const {
  annotateResults,
  getExecutionStatus,
  getValidatorExitCode,
} = require('../../../../ci/test-optimization-validation/result-semantics')

describe('test optimization validation result semantics', () => {
  it('returns zero when selected checks reach clean confirmed conclusions', () => {
    const results = annotateResults([getResult('basic-reporting', 'pass')])
    const executionStatus = getExecutionStatus(results)

    assert.strictEqual(executionStatus, 'completed')
    assert.strictEqual(getValidatorExitCode(results, executionStatus), 0)
    assert.strictEqual(results[0].conclusion, 'confirmed_working')
  })

  it('returns one for a confirmed static CI configuration finding', () => {
    const results = annotateResults([getResult('ci-wiring', 'fail', {
      conclusion: 'confirmed_misconfigured',
      domain: 'ci_configuration',
      evidenceStrength: 'confirmed_static',
    })])
    const executionStatus = getExecutionStatus(results)

    assert.strictEqual(executionStatus, 'completed')
    assert.strictEqual(getValidatorExitCode(results, executionStatus), 1)
  })

  it('returns two when the strongest defensible result remains incomplete', () => {
    const results = annotateResults([getResult('ci-wiring', 'error', {
      conclusion: 'configured_propagation_unverified',
      domain: 'ci_configuration',
      evidenceStrength: 'inferred_static',
    })])
    const executionStatus = getExecutionStatus(results)

    assert.strictEqual(executionStatus, 'completed')
    assert.strictEqual(getValidatorExitCode(results, executionStatus), 2)
  })

  it('returns three for validator orchestration failure', () => {
    const results = annotateResults([{
      ...getResult('all', 'error'),
      frameworkId: 'validator',
      evidence: { validationOrchestrationFailed: true },
    }])
    const executionStatus = getExecutionStatus(results)

    assert.strictEqual(executionStatus, 'validator_error')
    assert.strictEqual(getValidatorExitCode(results, executionStatus), 3)
  })
})

/**
 * Creates a result fixture.
 *
 * @param {string} scenario scenario id
 * @param {string} status legacy result status
 * @param {object} [evidence] result evidence
 * @returns {object} result fixture
 */
function getResult (scenario, status, evidence = {}) {
  return {
    frameworkId: 'vitest:root',
    scenario,
    status,
    diagnosis: 'Fixture result.',
    evidence,
    artifacts: [],
  }
}
