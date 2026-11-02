'use strict'

const assert = require('node:assert/strict')

const { toSupportedVersions } = require('../../../scripts/generate-supported-versions')

describe('generate supported versions', () => {
  it('converts supported integration rows to the published format', () => {
    const rows = [{
      dependency: 'express',
      integration: 'express',
      minimum_tracer_supported: '4.0.0',
      max_tracer_supported: '5.1.0',
      'auto-instrumented': 'True',
    }]

    assert.deepStrictEqual(toSupportedVersions(rows, { min: '18.0.0', max: '24.1.0' }), [{
      dependencyName: 'express',
      integrationName: 'express',
      autoInstrumented: true,
      versions: [{
        testedRuntimes: { node: ['18.0.0', '24.1.0'] },
        supportedRange: '>=4.0.0',
        tested: ['5.1.0'],
      }],
    }])
  })
})
