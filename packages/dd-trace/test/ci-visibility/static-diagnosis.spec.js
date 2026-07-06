'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { runDiagnosis } = require('../../../../ci/diagnose')
const { getStaticBlocker } = require('../../../../ci/test-optimization-validation/static-diagnosis')

describe('test optimization validation static diagnosis', () => {
  it('keeps root package metadata when the text file scan is truncated', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-static-diagnosis-'))
    const nestedRoot = path.join(root, 'aaaa')

    fs.mkdirSync(nestedRoot)
    fs.writeFileSync(path.join(nestedRoot, 'package.json'), JSON.stringify({
      devDependencies: {
        jest: '29.7.0',
      },
    }))
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      devDependencies: {
        'dd-trace': 'file:../dd-trace',
        jest: '29.7.0',
      },
      scripts: {
        test: 'jest',
      },
    }))

    try {
      const report = runDiagnosis({
        root,
        maxFiles: 1,
        execFile () {
          throw new Error('git unavailable')
        },
      })
      const titles = report.results.map(result => result.title)

      assert.strictEqual(report.truncatedFileScan, true)
      assert.ok(titles.includes('Root package.json found'))
      assert.ok(titles.includes('dd-trace dependency found'))
      assert.ok(!titles.includes('No root package.json found'))
      assert.ok(!titles.includes('dd-trace dependency not found in package.json'))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('marks dd-trace dependency presence as undetermined when the file scan is truncated', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-static-diagnosis-'))
    const nestedRoot = path.join(root, 'aaaa')

    fs.mkdirSync(nestedRoot)
    fs.writeFileSync(path.join(nestedRoot, 'package.json'), JSON.stringify({
      devDependencies: {
        jest: '29.7.0',
      },
    }))
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      devDependencies: {
        jest: '29.7.0',
      },
      scripts: {
        test: 'jest',
      },
    }))

    try {
      const report = runDiagnosis({
        root,
        maxFiles: 1,
        execFile () {
          throw new Error('git unavailable')
        },
      })
      const titles = report.results.map(result => result.title)

      assert.strictEqual(report.truncatedFileScan, true)
      assert.ok(titles.includes('dd-trace dependency not determined'))
      assert.ok(!titles.includes('dd-trace dependency not found in package.json'))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

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
