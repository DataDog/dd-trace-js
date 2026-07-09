'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { runDiagnosis } = require('../../../../ci/diagnose')
const {
  getStaticBlocker,
  runStaticDiagnosis,
} = require('../../../../ci/test-optimization-validation/static-diagnosis')

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

  it('recognizes resolved node_modules dd-trace init preload paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-static-diagnosis-'))
    const workflowDir = path.join(root, '.github', 'workflows')

    fs.mkdirSync(workflowDir, { recursive: true })
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      devDependencies: {
        'dd-trace': 'file:../dd-trace',
        jest: '29.7.0',
      },
      scripts: {
        test: 'jest',
      },
    }))
    fs.writeFileSync(path.join(workflowDir, 'test.yml'), [
      'name: test',
      'jobs:',
      '  unit:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: npm test',
      '        env:',
      '          NODE_OPTIONS: -r ./node_modules/dd-trace/ci/init.js',
      '',
    ].join('\n'))

    try {
      const report = runDiagnosis({
        root,
        execFile () {
          throw new Error('git unavailable')
        },
      })
      const titles = report.results.map(result => result.title)

      assert.ok(titles.includes('Test Optimization initialization found'))
      assert.ok(!titles.includes('Missing Test Optimization initialization'))
      assert.ok(!titles.includes('CI workflows do not show Test Optimization initialization'))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('recognizes Azure workflow files under .azure-pipelines', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-static-diagnosis-'))
    const workflowDir = path.join(root, '.azure-pipelines')

    fs.mkdirSync(workflowDir, { recursive: true })
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      devDependencies: {
        'dd-trace': 'file:../dd-trace',
        jest: '29.7.0',
      },
      scripts: {
        test: 'jest',
      },
    }))
    fs.writeFileSync(path.join(workflowDir, 'ci.yml'), [
      'jobs:',
      '- job: unit',
      '  steps:',
      '  - script: npm test',
      '    env:',
      '      NODE_OPTIONS: -r dd-trace/ci/init',
      '',
    ].join('\n'))

    try {
      const report = runDiagnosis({
        root,
        execFile () {
          throw new Error('git unavailable')
        },
      })
      const workflowResult = report.results.find(result => result.title === 'CI workflow files found')

      assert.ok(workflowResult)
      assert.deepStrictEqual(workflowResult.locations, ['.azure-pipelines/ci.yml'])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('redacts secret-like values from the standalone static diagnosis artifact', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-static-diagnosis-'))
    const out = path.join(root, 'results')

    fs.mkdirSync(out)
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      devDependencies: {
        'dd-trace': 'file:../dd-trace',
        jest: '29.7.0',
      },
      scripts: {
        test: 'DD_API_KEY=static-diagnosis-secret jest',
      },
    }))

    try {
      const staticDiagnosis = runStaticDiagnosis({
        manifest: {
          repository: { root },
        },
        out,
      })
      const artifact = fs.readFileSync(staticDiagnosis.reportPath, 'utf8')

      assert.match(JSON.stringify(staticDiagnosis.report), /static-diagnosis-secret/)
      assert.match(artifact, /DD_API_KEY=<redacted>/)
      assert.doesNotMatch(artifact, /static-diagnosis-secret/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not treat plain dd-trace app initialization as test setup initialization', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-static-diagnosis-'))

    fs.mkdirSync(path.join(root, 'src'))
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      devDependencies: {
        'dd-trace': 'file:../dd-trace',
        jest: '29.7.0',
      },
      scripts: {
        test: 'NODE_OPTIONS="-r dd-trace/ci/init" jest',
      },
    }))
    fs.writeFileSync(path.join(root, 'src', 'server.js'), 'require("dd-trace").init()\n')

    try {
      const report = runDiagnosis({
        root,
        execFile () {
          throw new Error('git unavailable')
        },
      })
      const titles = report.results.map(result => result.title)

      assert.ok(!titles.includes('Plain dd-trace initialization found in test setup'))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports plain dd-trace initialization in likely test setup files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-static-diagnosis-'))

    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      devDependencies: {
        'dd-trace': 'file:../dd-trace',
        jest: '29.7.0',
      },
      scripts: {
        test: 'NODE_OPTIONS="-r dd-trace/ci/init" jest',
      },
    }))
    fs.writeFileSync(path.join(root, 'jest.setup.js'), 'require("dd-trace").init()\n')

    try {
      const report = runDiagnosis({
        root,
        execFile () {
          throw new Error('git unavailable')
        },
      })
      const result = report.results.find(result => result.title === 'Plain dd-trace initialization found in test setup')

      assert.ok(result)
      assert.deepStrictEqual(result.locations, ['jest.setup.js'])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not coerce upper-bound-only framework ranges to supported boundary versions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-static-diagnosis-'))

    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      devDependencies: {
        'dd-trace': 'file:../dd-trace',
        jest: '<28.0.0',
      },
      scripts: {
        test: 'NODE_OPTIONS="-r dd-trace/ci/init" jest',
      },
    }))

    try {
      const report = runDiagnosis({
        root,
        execFile () {
          throw new Error('git unavailable')
        },
      })
      const titles = report.results.map(result => result.title)

      assert.ok(titles.includes('Jest version could not be determined'))
      assert.ok(!titles.includes('Jest 28.0.0 is supported'))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not select Jest watchAll scripts as eligible validation commands', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-static-diagnosis-'))

    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      devDependencies: {
        'dd-trace': 'file:../dd-trace',
        jest: '29.7.0',
      },
      scripts: {
        test: 'NODE_OPTIONS="-r dd-trace/ci/init" jest --watchAll',
      },
    }))

    try {
      const report = runDiagnosis({
        root,
        execFile () {
          throw new Error('git unavailable')
        },
      })

      assert.deepStrictEqual(report.eligibleFrameworks, [])
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
