'use strict'

const assert = require('node:assert/strict')

const { buildValidationPayloads } = require('../../../../ci/test-optimization-validation/validation-payload')

describe('test optimization validation payload', () => {
  it('omits fake intake setup from successful live-run steps', () => {
    const [{ payload }] = buildValidationPayloads({
      manifest: {
        frameworks: [
          {
            id: 'mocha:root',
            framework: 'mocha',
            frameworkVersion: '11.7.6',
          },
        ],
      },
      results: [
        {
          frameworkId: 'mocha:root',
          scenario: 'basic-reporting',
          status: 'pass',
          diagnosis: 'Basic reporting emitted session, module, suite, and test events.',
          evidence: {
            commandExitCode: 0,
            testSessionEvents: 1,
            testModuleEvents: 1,
            testSuiteEvents: 1,
            testEvents: 2,
          },
          artifacts: [],
        },
      ],
      artifacts: {
        htmlFileUrl: 'file:///tmp/report.html',
        htmlPath: '/tmp/report.html',
      },
    })

    assert.deepStrictEqual(payload.checks[0].steps.map(step => step.id), [
      'run-tests',
      'check-events',
    ])
  })

  it('collapses validator plumbing failures to the check level', () => {
    const diagnosis = 'The local fake intake could not start, so live validation was not run: listen EPERM'
    const [{ payload }] = buildValidationPayloads({
      manifest: {
        frameworks: [
          {
            id: 'mocha:root',
            framework: 'mocha',
            frameworkVersion: '11.7.6',
          },
        ],
      },
      results: [
        {
          frameworkId: 'mocha:root',
          scenario: 'basic-reporting',
          status: 'error',
          diagnosis,
          evidence: {
            intakeStarted: false,
          },
          artifacts: [],
        },
      ],
      artifacts: {
        htmlFileUrl: 'file:///tmp/report.html',
        htmlPath: '/tmp/report.html',
      },
    })

    assert.strictEqual(payload.checks[0].status, 'failed')
    assert.strictEqual(payload.checks[0].reason, diagnosis)
    assert.deepStrictEqual(payload.checks[0].steps, [])
  })

  it('does not emit live-run steps when no validation command was available', () => {
    const diagnosis = 'cypress was detected, but no runnable validation command was available.'
    const [{ payload }] = buildValidationPayloads({
      manifest: {
        frameworks: [
          {
            id: 'cypress:root',
            framework: 'cypress',
            frameworkVersion: '14.5.4',
          },
        ],
      },
      results: [
        {
          frameworkId: 'cypress:root',
          scenario: 'all',
          status: 'fail',
          diagnosis,
          evidence: {
            frameworkStatus: 'requires_manual_setup',
          },
          artifacts: [],
        },
      ],
      artifacts: {
        htmlFileUrl: 'file:///tmp/report.html',
        htmlPath: '/tmp/report.html',
      },
    })

    assert.strictEqual(payload.status, 'failed')
    assert.deepStrictEqual(payload.checks, [
      {
        id: 'basic-reporting',
        name: 'Basic reporting',
        status: 'failed',
        reason: diagnosis,
        steps: [],
      },
    ])
  })
})
