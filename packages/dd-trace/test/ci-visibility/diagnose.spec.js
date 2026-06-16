'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { afterEach, beforeEach, describe, it } = require('mocha')

const {
  getExitCode,
  renderText,
  runDiagnosis,
} = require('../../../../ci/diagnose')

describe('Test Optimization diagnosis script', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-diagnose-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reports a supported Jest setup', () => {
    writeJson('package.json', {
      scripts: {
        test: 'jest',
      },
      devDependencies: {
        'dd-trace': '^6.0.0',
        jest: '^29.7.0',
      },
    })
    writeJson('node_modules/jest/package.json', { version: '29.7.0' })
    writeFile('.github/workflows/test.yml', [
      'jobs:',
      '  test:',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '        with:',
      '          fetch-depth: 0',
      '      - run: npm test',
      '        env:',
      '          NODE_OPTIONS: "-r dd-trace/ci/init"',
      '          DD_SERVICE: web',
      '          DD_API_KEY: $' + '{{ secrets.DD_API_KEY }}',
      '',
    ].join('\n'))

    const report = diagnose()

    assert.ok(hasResult(report, 'ok', 'Jest 29.7.0 is supported'))
    assert.deepStrictEqual(report.eligibleFrameworks, [
      {
        command: 'jest',
        commandLocation: 'package.json',
        id: 'jest',
        name: 'Jest',
        supportedRange: '>=28.0.0',
        version: '29.7.0',
        versionLocation: undefined,
      },
    ])
    assert.ok(hasResult(report, 'ok', 'Test Optimization initialization found'))
    assert.strictEqual(getExitCode(report, 'error'), 0)
  })

  it('reports unsupported frameworks and missing initialization', () => {
    writeJson('package.json', {
      scripts: {
        test: 'ava',
      },
      devDependencies: {
        'dd-trace': '^6.0.0',
        ava: '^6.0.0',
      },
    })

    const report = diagnose({ env: { DD_SERVICE: 'web', NODE_OPTIONS: '' } })

    assert.ok(hasResult(report, 'error', 'AVA is not supported by Test Optimization'))
    assert.ok(hasResult(report, 'warning', 'No supported test framework detected'))
    assert.ok(!hasResult(report, 'error', 'Missing Test Optimization initialization'))
    assert.strictEqual(getExitCode(report, 'error'), 1)
  })

  it('reports unsupported framework versions', () => {
    writeJson('package.json', {
      scripts: {
        test: 'cypress run',
      },
      devDependencies: {
        'dd-trace': '^6.0.0',
        cypress: '11.2.0',
      },
    })

    const report = diagnose()

    assert.ok(hasResult(report, 'error', 'Cypress 11.2.0 is not supported'))
    assert.deepStrictEqual(report.eligibleFrameworks, [])
    assert.match(renderText(report), /Upgrade Cypress to >=12\.0\.0/)
  })

  it('reports TypeScript Jest config risk without ts-node', () => {
    writeJson('package.json', {
      scripts: {
        test: 'jest',
      },
      devDependencies: {
        'dd-trace': '^6.0.0',
        jest: '^29.0.0',
      },
    })
    writeJson('node_modules/jest/package.json', { version: '29.7.0' })
    writeFile('jest.config.ts', 'export default {}\n')

    const report = diagnose()

    assert.ok(hasResult(report, 'warning', 'Jest TypeScript config may need ts-node'))
  })

  it('reports plain dd-trace initialization in test setup', () => {
    writeJson('package.json', {
      scripts: {
        test: 'jest',
      },
      devDependencies: {
        'dd-trace': '^6.0.0',
        jest: '^29.0.0',
      },
    })
    writeFile('jest.setup.js', "require('dd-trace').init()\n")

    const report = diagnose({ env: { DD_SERVICE: 'web', NODE_OPTIONS: '' } })

    assert.ok(hasResult(report, 'error', 'Missing Test Optimization initialization'))
    assert.ok(hasResult(report, 'error', 'Plain dd-trace initialization found in test setup'))
  })

  it('reports direct Test Optimization initialization imports as invalid', () => {
    writeJson('package.json', {
      scripts: {
        test: 'jest',
      },
      devDependencies: {
        'dd-trace': '^6.0.0',
        jest: '^29.0.0',
      },
    })
    writeFile('jest.setup.js', "require('dd-trace/ci/init')\n")

    const report = diagnose({ env: { DD_SERVICE: 'web', NODE_OPTIONS: '' } })

    assert.ok(hasResult(report, 'error', 'Missing Test Optimization initialization'))
    assert.ok(hasResult(report, 'error', 'Test Optimization initialization is imported directly'))
  })

  it('requires dd-trace/ci/init to be preloaded from NODE_OPTIONS', () => {
    writeJson('package.json', {
      scripts: {
        test: 'NODE_OPTIONS="--max-old-space-size=4096" jest',
      },
      devDependencies: {
        'dd-trace': '^6.0.0',
        jest: '^29.0.0',
      },
    })
    writeFile('jest.setup.js', 'const init = "dd-trace/ci/init"\n')

    const report = diagnose({ env: { DD_SERVICE: 'web', NODE_OPTIONS: 'dd-trace/ci/init' } })

    assert.ok(hasResult(report, 'error', 'Missing Test Optimization initialization'))
    assert.ok(!hasResult(report, 'ok', 'Test Optimization initialization found'))
  })

  it('reports shallow GitHub Actions checkout risk', () => {
    writeJson('package.json', {
      scripts: {
        test: 'mocha',
      },
      devDependencies: {
        'dd-trace': '^6.0.0',
        mocha: '^11.0.0',
      },
    })
    writeFile('.github/workflows/test.yml', [
      'jobs:',
      '  test:',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - run: npm test',
      '        env:',
      '          NODE_OPTIONS: "-r dd-trace/ci/init"',
      '          DD_SERVICE: web',
      '',
    ].join('\n'))

    const report = diagnose()

    assert.ok(hasResult(report, 'warning', 'GitHub Actions checkout may be shallow'))
  })

  it('reports missing git executable', () => {
    writeJson('package.json', {
      scripts: {
        test: 'vitest',
      },
      devDependencies: {
        'dd-trace': '^6.0.0',
        vitest: '^1.6.0',
      },
    })

    const report = diagnose({
      execFile: () => {
        throw new Error('ENOENT')
      },
    })

    assert.ok(hasResult(report, 'error', 'git executable is not available'))
  })

  function diagnose (options = {}) {
    return runDiagnosis({
      root: tmpDir,
      env: {
        DD_SERVICE: 'web',
        NODE_OPTIONS: '-r dd-trace/ci/init',
        ...options.env,
      },
      execFile: options.execFile || fakeGit(),
    })
  }

  function writeJson (relativePath, data) {
    writeFile(relativePath, `${JSON.stringify(data, null, 2)}\n`)
  }

  function writeFile (relativePath, content) {
    const filePath = path.join(tmpDir, relativePath)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, content)
  }
})

function hasResult (report, status, title) {
  return report.results.some(result => result.status === status && result.title === title)
}

function fakeGit () {
  return function execFile (command, args) {
    assert.strictEqual(command, 'git')

    const key = args.join(' ')
    const outputs = {
      '--version': 'git version 2.40.0\n',
      'rev-parse --is-inside-work-tree': 'true\n',
      'rev-parse HEAD': 'abcdef1234567890\n',
      'config --get remote.origin.url': 'git@github.com:example/repo.git\n',
      'branch --show-current': 'main\n',
      'rev-parse --is-shallow-repository': 'false\n',
    }

    if (Object.hasOwn(outputs, key)) {
      return Buffer.from(outputs[key])
    }

    throw new Error(`Unexpected git command: ${key}`)
  }
}
