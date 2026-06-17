'use strict'

const assert = require('node:assert/strict')

const { buildValidationPayloads } = require('../../../../ci/test-optimization-validation/validation-payload')

describe('test optimization validation payload', () => {
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
