'use strict'

const assert = require('node:assert/strict')

const {
  annotateResults,
  getExecutionStatus,
  getValidatorExitCode,
} = require('../../../../ci/test-optimization-validation/result-semantics')

describe('test optimization validation result semantics', () => {
  const decisionCases = [
    {
      name: 'returns zero when selected checks reach clean confirmed conclusions',
      results: [getResult('basic-reporting', 'pass')],
      executionStatus: 'completed',
      exitCode: 0,
      resultSemantics: [{ conclusion: 'confirmed_working', domain: 'test_optimization' }],
    },
    {
      name: 'returns one when local reporting works but CI is confirmed misconfigured',
      results: [
        getResult('basic-reporting', 'pass'),
        getResult('ci-wiring', 'fail', confirmedCiMisconfiguration()),
        ...getPassingAdvancedResults(),
      ],
      executionStatus: 'completed',
      exitCode: 1,
      resultSemantics: [
        { conclusion: 'confirmed_working', domain: 'test_optimization' },
        { conclusion: 'confirmed_misconfigured', domain: 'ci_configuration' },
      ],
    },
    {
      name: 'returns two when CI is configured but propagation remains unverified',
      results: [
        getResult('basic-reporting', 'pass'),
        getResult('ci-wiring', 'error', incompleteCiEvidence('configured_propagation_unverified')),
        ...getPassingAdvancedResults(),
      ],
      executionStatus: 'completed',
      exitCode: 2,
      resultSemantics: [
        { conclusion: 'confirmed_working', domain: 'test_optimization' },
        { conclusion: 'configured_propagation_unverified', domain: 'ci_configuration' },
      ],
    },
    {
      name: 'returns two when CI configuration cannot be determined',
      results: [
        getResult('basic-reporting', 'pass'),
        getResult('ci-wiring', 'error', incompleteCiEvidence('incomplete')),
      ],
      executionStatus: 'completed',
      exitCode: 2,
      resultSemantics: [
        { conclusion: 'confirmed_working', domain: 'test_optimization' },
        { conclusion: 'incomplete', domain: 'ci_configuration' },
      ],
    },
    {
      name: 'keeps a local reporting failure separate from a confirmed CI misconfiguration',
      results: [
        getResult('basic-reporting', 'fail'),
        getResult('ci-wiring', 'fail', confirmedCiMisconfiguration()),
        ...getSkippedAdvancedResults(),
      ],
      executionStatus: 'completed',
      exitCode: 1,
      resultSemantics: [
        { conclusion: 'confirmed_not_working', domain: 'test_optimization' },
        { conclusion: 'confirmed_misconfigured', domain: 'ci_configuration' },
      ],
    },
    {
      name: 'reports required project setup separately from sandbox blocking',
      results: [
        getResult('all', 'blocked', {
          blockedByProjectSetup: true,
          setupFailed: true,
        }),
        getResult('ci-wiring', 'error', incompleteCiEvidence('incomplete')),
      ],
      executionStatus: 'project_setup_required',
      exitCode: 2,
      resultSemantics: [
        { conclusion: 'incomplete', domain: 'project_setup' },
        { conclusion: 'incomplete', domain: 'ci_configuration' },
      ],
    },
    {
      name: 'returns two when the execution environment blocks local validation',
      results: [
        getResult('basic-reporting', 'blocked', { blockedByExecutionEnvironment: true }),
        getResult('ci-wiring', 'error', incompleteCiEvidence('incomplete')),
      ],
      executionStatus: 'blocked',
      exitCode: 2,
      resultSemantics: [
        { conclusion: 'incomplete', domain: 'execution_environment' },
        { conclusion: 'incomplete', domain: 'ci_configuration' },
      ],
    },
    {
      name: 'returns two when no supported runnable adapter produced live evidence',
      results: [{
        ...getResult('all', 'skip', { validatorAdapterUnavailable: true }),
        frameworkId: 'playwright:root',
      }],
      executionStatus: 'completed',
      exitCode: 2,
      resultSemantics: [{ conclusion: 'not_eligible', domain: 'validator_adapter' }],
    },
    {
      name: 'returns one for a confirmed advanced-feature failure despite incomplete CI evidence',
      results: [
        getResult('basic-reporting', 'pass'),
        getResult('ci-wiring', 'error', incompleteCiEvidence('configured_propagation_unverified')),
        getResult('atr', 'fail'),
      ],
      executionStatus: 'completed',
      exitCode: 1,
      resultSemantics: [
        { conclusion: 'confirmed_working', domain: 'test_optimization' },
        { conclusion: 'configured_propagation_unverified', domain: 'ci_configuration' },
        { conclusion: 'confirmed_not_working', domain: 'test_optimization' },
      ],
    },
    {
      name: 'returns three for validator orchestration failure',
      results: [{
        ...getResult('all', 'error'),
        frameworkId: 'validator',
        evidence: { validationOrchestrationFailed: true },
      }],
      executionStatus: 'validator_error',
      exitCode: 3,
      resultSemantics: [{ conclusion: 'incomplete', domain: 'validator_adapter' }],
    },
  ]

  for (const decisionCase of decisionCases) {
    it(decisionCase.name, () => {
      const results = annotateResults(decisionCase.results)
      const executionStatus = getExecutionStatus(results)

      assert.strictEqual(executionStatus, decisionCase.executionStatus)
      assert.strictEqual(getValidatorExitCode(results, executionStatus), decisionCase.exitCode)
      assert.deepStrictEqual(results.slice(0, decisionCase.resultSemantics.length).map(result => ({
        conclusion: result.conclusion,
        domain: result.domain,
      })), decisionCase.resultSemantics)
    })
  }
})

function confirmedCiMisconfiguration () {
  return {
    conclusion: 'confirmed_misconfigured',
    domain: 'ci_configuration',
    evidenceStrength: 'confirmed_static',
  }
}

function incompleteCiEvidence (conclusion) {
  return {
    conclusion,
    domain: 'ci_configuration',
    evidenceStrength: conclusion === 'incomplete' ? 'unknown' : 'inferred_static',
  }
}

function getPassingAdvancedResults () {
  return ['efd', 'atr', 'test-management'].map(scenario => getResult(scenario, 'pass'))
}

function getSkippedAdvancedResults () {
  return ['efd', 'atr', 'test-management'].map(scenario => getResult(scenario, 'skip', {
    featureEligibility: { eligible: false, blockedBy: 'basic-reporting' },
  }))
}

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
