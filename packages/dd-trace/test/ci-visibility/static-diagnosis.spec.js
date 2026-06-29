'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { getStaticBlocker } = require('../../../../ci/test-optimization-validation/static-diagnosis')

describe('test optimization validation static diagnosis', () => {
  it('does not block a root framework entry with an unsupported nested fixture version', () => {
    const diagnosis = getDiagnosisWithNestedMochaError()
    const framework = {
      id: 'mocha:root-smoke',
      framework: 'mocha',
      frameworkVersion: '12.0.0-rc.1',
      project: {
        root: diagnosis.root,
        packageJson: path.join(diagnosis.root, 'package.json'),
      },
    }

    assert.strictEqual(getStaticBlocker(framework, diagnosis), null)
  })

  it('blocks the framework entry that owns the unsupported version location', () => {
    const diagnosis = getDiagnosisWithNestedMochaError()
    const framework = {
      id: 'mocha:fixture-config-package',
      framework: 'mocha',
      frameworkVersion: null,
      project: {
        root: path.join(diagnosis.root, 'test/integration/fixtures/config/mocha-config'),
        packageJson: path.join(diagnosis.root, 'test/integration/fixtures/config/mocha-config/package.json'),
      },
    }

    assert.deepStrictEqual(getStaticBlocker(framework, diagnosis), {
      reason: 'Mocha 7.0.0 is not supported',
      recommendation: 'Upgrade Mocha to >=8.0.0, or use dd-trace v5 for older Mocha versions.',
    })
  })

  it('keeps ambiguous repository-wide version errors for entries without an explicit supported version', () => {
    const diagnosis = {
      root: '/repo',
      ddTraceMajor: 6,
      results: [
        {
          status: 'error',
          title: 'Mocha 7.0.0 is not supported',
          message: 'Detected mocha@^7.0.0 from package manifest; supported range is >=8.0.0.',
          recommendation: 'Upgrade Mocha to >=8.0.0, or use dd-trace v5 for older Mocha versions.',
        },
      ],
    }
    const framework = {
      id: 'mocha:root',
      framework: 'mocha',
      frameworkVersion: null,
      project: {
        root: diagnosis.root,
        packageJson: path.join(diagnosis.root, 'package.json'),
      },
    }

    assert.deepStrictEqual(getStaticBlocker(framework, diagnosis), {
      reason: 'Mocha 7.0.0 is not supported',
      recommendation: 'Upgrade Mocha to >=8.0.0, or use dd-trace v5 for older Mocha versions.',
    })
  })
})

function getDiagnosisWithNestedMochaError () {
  return {
    root: '/repo',
    ddTraceMajor: 6,
    results: [
      {
        status: 'error',
        title: 'Mocha 7.0.0 is not supported',
        message: 'Detected mocha@^7.0.0 from package manifest; supported range is >=8.0.0.',
        locations: ['test/integration/fixtures/config/mocha-config/package.json'],
        recommendation: 'Upgrade Mocha to >=8.0.0, or use dd-trace v5 for older Mocha versions.',
      },
    ],
  }
}
