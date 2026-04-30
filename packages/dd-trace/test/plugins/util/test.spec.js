'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { describe, it, beforeEach, afterEach } = require('mocha')
const context = describe
const sinon = require('sinon')
const proxyquire = require('proxyquire')

const istanbul = require('../../../../../vendor/dist/istanbul-lib-coverage')
require('../../setup/core')

const {
  getTestParametersString,
  getTestSuitePath,
  getCodeOwnersFileEntries,
  getCodeOwnersForFilename,
  getCoveredFilenamesFromCoverage,
  mergeCoverage,
  resetCoverage,
  removeInvalidMetadata,
  parseAnnotations,
  getIsFaultyEarlyFlakeDetection,
  getTestSessionName,
  getNumFromKnownTests,
  getModifiedFilesFromDiff,
  isModifiedTest,
  recordAttemptToFixExecution,
  collectAttemptToFixExecutionsFromTraces,
  formatAttemptToFixSummary,
  logAttemptToFixSummary,
  logAttemptToFixTestExecution,
  logTestOptimizationSummary,
} = require('../../../src/plugins/util/test')

const { GIT_REPOSITORY_URL, GIT_COMMIT_SHA, CI_PIPELINE_URL } = require('../../../src/plugins/util/tags')
const {
  TELEMETRY_GIT_COMMIT_SHA_DISCREPANCY,
  TELEMETRY_GIT_SHA_MATCH,
} = require('../../../src/ci-visibility/telemetry')

describe('getTestParametersString', () => {
  it('returns formatted test parameters and removes params from input', () => {
    const input = { test_stuff: [['params'], [{ b: 'c' }]] }
    assert.strictEqual(getTestParametersString(input, 'test_stuff'),
      JSON.stringify({ arguments: ['params'], metadata: {} })
    )
    assert.deepStrictEqual(input, { test_stuff: [[{ b: 'c' }]] })
    assert.strictEqual(getTestParametersString(input, 'test_stuff'),
      JSON.stringify({ arguments: [{ b: 'c' }], metadata: {} })
    )
    assert.deepStrictEqual(input, { test_stuff: [] })
  })

  it('does not crash when test name is not found and does not modify input', () => {
    const input = { test_stuff: [['params'], ['params2']] }
    assert.strictEqual(getTestParametersString(input, 'test_not_present'), '')
    assert.deepStrictEqual(input, { test_stuff: [['params'], ['params2']] })
  })

  it('does not crash when parameters can not be serialized and removes params from input', () => {
    const circular = { a: 'b' }
    circular.b = circular

    const input = { test_stuff: [[circular], ['params2']] }
    assert.strictEqual(getTestParametersString(input, 'test_stuff'), '')
    assert.deepStrictEqual(input, { test_stuff: [['params2']] })
    assert.strictEqual(getTestParametersString(input, 'test_stuff'),
      JSON.stringify({ arguments: ['params2'], metadata: {} })
    )
  })
})

describe('getTestSuitePath', () => {
  it('returns sourceRoot if the test path is falsy', () => {
    const sourceRoot = '/users/opt'
    const testSuitePath = getTestSuitePath(undefined, sourceRoot)
    assert.strictEqual(testSuitePath, sourceRoot)
  })

  it('returns sourceRoot if the test path has the same value', () => {
    const sourceRoot = '/users/opt'
    const testSuiteAbsolutePath = sourceRoot
    const testSuitePath = getTestSuitePath(testSuiteAbsolutePath, sourceRoot)
    assert.strictEqual(testSuitePath, sourceRoot)
  })
})

describe('getTestSessionName', () => {
  let originalEnv

  beforeEach(() => {
    originalEnv = { ...process.env }
    delete process.env.DD_ENABLE_LAGE_PACKAGE_NAME
    delete process.env.LAGE_PACKAGE_NAME
    delete process.env.DD_TEST_SESSION_NAME
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('returns the explicit test optimization session name from config', () => {
    process.env.DD_ENABLE_LAGE_PACKAGE_NAME = 'true'
    process.env.LAGE_PACKAGE_NAME = 'lage-package'

    const testSessionName = getTestSessionName({ ciVisibilityTestSessionName: 'explicit-session' }, 'jest', {})

    assert.strictEqual(testSessionName, 'explicit-session')
  })

  it('returns the current Lage package name when enabled', () => {
    process.env.DD_ENABLE_LAGE_PACKAGE_NAME = 'true'
    process.env.LAGE_PACKAGE_NAME = 'lage-package-a'

    assert.strictEqual(getTestSessionName({}, 'jest', {}), 'lage-package-a')

    process.env.LAGE_PACKAGE_NAME = 'lage-package-b'

    assert.strictEqual(getTestSessionName({}, 'jest', {}), 'lage-package-b')
  })
})

describe('attempt to fix summary', () => {
  it('reports when every attempt to fix execution passes', () => {
    const executions = new Map()

    recordAttemptToFixExecution(executions, {
      testSuite: 'suite.js',
      testName: 'passes',
      status: 'pass',
    })
    recordAttemptToFixExecution(executions, {
      testSuite: 'suite.js',
      testName: 'passes',
      status: 'pass',
    })

    assert.strictEqual(
      formatAttemptToFixSummary(executions),
      'Attempt to fix passed: all 2 execution(s) passed for 1 test(s).'
    )
  })

  it('reports failed executions without error messages', () => {
    const executions = new Map()

    recordAttemptToFixExecution(executions, {
      testSuite: 'suite.js',
      testName: 'fails',
      status: 'fail',
    })

    const summary = formatAttemptToFixSummary(executions)

    assert.match(summary, /Attempt to fix failed: 1 of 1 execution\(s\) failed across 1 of 1 test\(s\)\./)
    assert.match(summary, /suite\.js › fails/)
    assert.ok(!summary.includes('Errors are suppressed because'))
    assert.ok(!summary.includes('Error:'))
    assert.ok(!summary.includes('execution 1:'))
  })

  it('reports when quarantine and disabled were ignored for attempt to fix', () => {
    const executions = new Map()

    recordAttemptToFixExecution(executions, {
      testSuite: 'suite.js',
      testName: 'passes',
      status: 'pass',
      isDisabled: true,
    })
    recordAttemptToFixExecution(executions, {
      testSuite: 'suite.js',
      testName: 'fails',
      status: 'fail',
      isQuarantined: true,
    })

    const summary = formatAttemptToFixSummary(executions)

    assert.match(summary, /Attempt to fix failed: 1 of 2 execution\(s\) failed across 1 of 2 test\(s\)\./)
    assert.match(summary, /suite\.js › fails/)
    assert.match(summary, /Test was marked as quarantined but was not quarantined because it is attempt to fix\./)
    assert.doesNotMatch(summary, /Test was marked as disabled but was run because it is attempt to fix\./)
  })

  it('reports ignored quarantine and disabled for passing attempt to fix tests', () => {
    const executions = new Map()

    recordAttemptToFixExecution(executions, {
      testSuite: 'suite.js',
      testName: 'passes',
      status: 'pass',
      isDisabled: true,
      isQuarantined: true,
    })

    const summary = formatAttemptToFixSummary(executions)

    assert.match(summary, /Attempt to fix passed: all 1 execution\(s\) passed for 1 test\(s\)\./)
    assert.match(summary, /suite\.js › passes/)
    assert.match(summary, /Test was marked as disabled but was run because it is attempt to fix\./)
    assert.match(summary, /Test was marked as quarantined but was not quarantined because it is attempt to fix\./)
  })

  it('lists each failed test once', () => {
    const executions = new Map()

    recordAttemptToFixExecution(executions, {
      testSuite: 'suite.js',
      testName: 'fails sometimes',
      status: 'fail',
    })
    recordAttemptToFixExecution(executions, {
      testSuite: 'suite.js',
      testName: 'fails sometimes',
      status: 'pass',
    })
    recordAttemptToFixExecution(executions, {
      testSuite: 'suite.js',
      testName: 'fails sometimes',
      status: 'fail',
    })
    recordAttemptToFixExecution(executions, {
      testSuite: 'suite.js',
      testName: 'always fails',
      status: 'fail',
    })

    const summary = formatAttemptToFixSummary(executions)

    assert.match(summary, /Attempt to fix failed: 3 of 4 execution\(s\) failed across 2 of 2 test\(s\)\./)
    assert.match(summary, /suite\.js › fails sometimes/)
    assert.match(summary, /suite\.js › always fails/)
    assert.strictEqual(summary.match(/suite\.js › fails sometimes/g).length, 1)
    assert.doesNotMatch(summary, /execution \d+:/)
  })

  it('collects attempt to fix executions from worker traces', () => {
    const executions = new Map()
    const payload = JSON.stringify([
      [
        {
          meta: {
            'test.test_management.is_attempt_to_fix': 'true',
            'test.suite': 'worker-suite.js',
            'test.name': 'worker test',
            'test.status': 'fail',
            'test.test_management.is_quarantined': 'true',
            'error.message': 'worker failure',
            'error.stack': 'Error: worker failure\n    at worker-suite.js:10:5',
          },
        },
      ],
    ])

    collectAttemptToFixExecutionsFromTraces(payload, executions)

    const summary = formatAttemptToFixSummary(executions)
    assert.match(summary, /worker-suite\.js › worker test/)
    assert.ok(!summary.includes('worker failure'))
    assert.ok(!summary.includes('worker-suite.js:10:5'))
    assert.ok(!summary.includes('Errors are suppressed because'))
    assert.match(summary, /Test was marked as quarantined but was not quarantined because it is attempt to fix\./)
  })

  it('logs and clears the attempt to fix summary', () => {
    const executions = new Map()
    const consoleWarn = sinon.stub(console, 'warn')

    recordAttemptToFixExecution(executions, {
      testSuite: 'suite.js',
      testName: 'passes',
      status: 'pass',
    })

    try {
      logAttemptToFixSummary(executions)
    } finally {
      consoleWarn.restore()
    }

    assert.strictEqual(executions.size, 0)
    assert.strictEqual(consoleWarn.callCount, 1)
    assert.match(consoleWarn.firstCall.args[0], /Datadog Test Optimization/)
    assert.match(consoleWarn.firstCall.args[0], /Attempt to fix passed/)
  })

  it('logs a compact progress line when an attempt to fix execution starts', () => {
    const consoleWarn = sinon.stub(console, 'warn')

    try {
      logAttemptToFixTestExecution('suite.js', 'test name')
    } finally {
      consoleWarn.restore()
    }

    assert.strictEqual(consoleWarn.callCount, 1)
    assert.strictEqual(
      consoleWarn.firstCall.args[0],
      'Datadog Test Optimization: attempting to fix suite.js › test name'
    )
  })

  it('logs the attempt to fix progress line once for a test effort', () => {
    const consoleWarn = sinon.stub(console, 'warn')
    const loggedAttemptToFixTests = new Set()

    try {
      logAttemptToFixTestExecution('suite.js', 'test name', loggedAttemptToFixTests)
      logAttemptToFixTestExecution('suite.js', 'test name', loggedAttemptToFixTests)
      logAttemptToFixTestExecution('suite.js', 'other test', loggedAttemptToFixTests)
    } finally {
      consoleWarn.restore()
    }

    assert.strictEqual(consoleWarn.callCount, 2)
    assert.strictEqual(
      consoleWarn.firstCall.args[0],
      'Datadog Test Optimization: attempting to fix suite.js › test name'
    )
    assert.strictEqual(
      consoleWarn.secondCall.args[0],
      'Datadog Test Optimization: attempting to fix suite.js › other test'
    )
  })

  it('combines attempt to fix and dynamic name sections into one session report', () => {
    const executions = new Map()
    const newTestsWithDynamicNames = new Set(['dynamic-suite.js › dynamic test 123'])
    const consoleWarn = sinon.stub(console, 'warn')

    recordAttemptToFixExecution(executions, {
      testSuite: 'suite.js',
      testName: 'passes',
      status: 'pass',
    })

    try {
      logTestOptimizationSummary({ attemptToFixExecutions: executions, newTestsWithDynamicNames })
    } finally {
      consoleWarn.restore()
    }

    assert.strictEqual(consoleWarn.callCount, 1)
    assert.strictEqual(executions.size, 0)
    assert.strictEqual(newTestsWithDynamicNames.size, 0)
    assert.match(consoleWarn.firstCall.args[0], /Attempt to fix passed/)
    assert.match(consoleWarn.firstCall.args[0], /dynamic-suite\.js › dynamic test 123/)
  })
})

describe('getCodeOwnersFileEntries', () => {
  it('returns code owners entries', () => {
    const rootDir = path.join(__dirname, '__test__')
    const codeOwnersFileEntries = getCodeOwnersFileEntries(rootDir)

    assert.deepStrictEqual(codeOwnersFileEntries[0], {
      pattern: 'packages/dd-trace/test/plugins/util/test.spec.js',
      owners: ['@datadog-ci-app'],
    })
    assert.deepStrictEqual(codeOwnersFileEntries[1], {
      pattern: 'packages/dd-trace/test/plugins/util/*',
      owners: ['@datadog-dd-trace-js'],
    })
  })

  it('returns null if CODEOWNERS can not be found', () => {
    const rootDir = path.join(__dirname, '__not_found__')
    // We have to change the working directory,
    // otherwise it will find the CODEOWNERS file in the root of dd-trace-js
    const oldCwd = process.cwd()
    process.chdir(path.join(__dirname))
    const codeOwnersFileEntries = getCodeOwnersFileEntries(rootDir)
    assert.strictEqual(codeOwnersFileEntries, null)
    process.chdir(oldCwd)
  })

  it('tries both input rootDir and process.cwd()', () => {
    const rootDir = path.join(__dirname, '__not_found__')
    const oldCwd = process.cwd()

    process.chdir(path.join(__dirname, '__test__'))
    const codeOwnersFileEntries = getCodeOwnersFileEntries(rootDir)

    assert.deepStrictEqual(codeOwnersFileEntries[0], {
      pattern: 'packages/dd-trace/test/plugins/util/test.spec.js',
      owners: ['@datadog-ci-app'],
    })
    assert.deepStrictEqual(codeOwnersFileEntries[1], {
      pattern: 'packages/dd-trace/test/plugins/util/*',
      owners: ['@datadog-dd-trace-js'],
    })
    process.chdir(oldCwd)
  })
})

describe('getCodeOwnersForFilename', () => {
  it('returns null if entries is empty', () => {
    const codeOwners = getCodeOwnersForFilename('filename', undefined)

    assert.strictEqual(codeOwners, null)
  })

  it('matches supported GitHub CODEOWNERS patterns', () => {
    const patternTests = [
      {
        pattern: '*',
        matches: ['index.js', 'packages/dd-trace/src/index.js'],
      },
      {
        pattern: '*.js',
        matches: ['index.js', 'packages/dd-trace/src/index.js'],
        misses: ['index.jsx', 'packages/dd-trace/src/index.js.map'],
      },
      {
        pattern: 'README.md',
        matches: ['README.md', 'packages/dd-trace/README.md'],
        misses: ['README.txt', 'packages/dd-trace/readme.md'],
      },
      {
        pattern: '/package.json',
        matches: ['package.json'],
        misses: ['packages/dd-trace/package.json'],
      },
      {
        pattern: '/docs/',
        matches: ['docs/README.md', 'docs/api/reference.md'],
        misses: ['src/docs/README.md'],
      },
      {
        pattern: 'apps/',
        matches: ['apps/api/index.js', 'packages/apps/api/index.js'],
        misses: ['applications/api/index.js'],
      },
      {
        pattern: 'docs/*',
        matches: ['docs/getting-started.md'],
        misses: ['docs/build-app/troubleshooting.md', 'src/docs/getting-started.md'],
      },
      {
        pattern: '**/logs',
        matches: ['logs/app.log', 'build/logs/app.log', 'deeply/nested/logs/app.log'],
        misses: ['build/logs-old/app.log'],
      },
      {
        pattern: 'logs/**',
        matches: ['logs/app.log', 'logs/deeply/nested/app.log'],
        misses: ['src/logs/app.log'],
      },
      {
        pattern: '/packages/**/dsm.spec.js',
        matches: ['packages/dsm.spec.js', 'packages/datadog-plugin-kafkajs/test/dsm.spec.js'],
        misses: ['src/packages/datadog-plugin-kafkajs/test/dsm.spec.js'],
      },
      {
        pattern: 'file?.js',
        matches: ['file1.js', 'packages/dd-trace/fileA.js'],
        misses: ['file10.js', 'packages/dd-trace/file/name.js'],
      },
    ]

    for (const { pattern, matches = [], misses = [] } of patternTests) {
      const entries = [{ pattern, owners: [`@owner-${pattern}`] }]
      const expectedCodeOwners = JSON.stringify([`@owner-${pattern}`])

      for (const filename of matches) {
        assert.strictEqual(getCodeOwnersForFilename(filename, entries), expectedCodeOwners)
      }

      for (const filename of misses) {
        assert.strictEqual(getCodeOwnersForFilename(filename, entries), null)
      }
    }
  })

  it('keeps CODEOWNERS matching case-sensitive', () => {
    const codeOwnersFileEntries = [
      { pattern: '/Docs/', owners: ['@datadog-docs'] },
    ]

    assert.strictEqual(
      getCodeOwnersForFilename('Docs/reference.md', codeOwnersFileEntries),
      JSON.stringify(['@datadog-docs'])
    )
    assert.strictEqual(getCodeOwnersForFilename('docs/reference.md', codeOwnersFileEntries), null)
  })

  it('uses the last matching CODEOWNERS entry', () => {
    const codeOwnersFileEntries = [
      { pattern: '*.js', owners: ['@datadog-default-js'] },
      { pattern: '/packages/dd-trace/', owners: ['@datadog-dd-trace-js'] },
    ].reverse()

    const codeOwners = getCodeOwnersForFilename(
      'packages/dd-trace/src/index.js',
      codeOwnersFileEntries
    )

    assert.strictEqual(codeOwners, JSON.stringify(['@datadog-dd-trace-js']))
  })

  it('preserves multiple CODEOWNERS owners and email owners', () => {
    const codeOwnersFileEntries = [
      {
        pattern: '*.js',
        owners: ['@datadog-team-a', '@datadog/team-b', 'user@example.com'],
      },
    ]

    const codeOwners = getCodeOwnersForFilename('index.js', codeOwnersFileEntries)

    assert.strictEqual(codeOwners, JSON.stringify(['@datadog-team-a', '@datadog/team-b', 'user@example.com']))
  })

  it('supports empty owner overrides', () => {
    const codeOwnersFileEntries = [
      { pattern: '*', owners: ['@datadog-default'] },
      { pattern: '/apps/github', owners: [] },
    ].reverse()

    const codeOwners = getCodeOwnersForFilename('apps/github/index.js', codeOwnersFileEntries)

    assert.strictEqual(codeOwners, JSON.stringify([]))
  })

  it('returns the code owners for a given file path', () => {
    const rootDir = path.join(__dirname, '__test__')
    const codeOwnersFileEntries = getCodeOwnersFileEntries(rootDir)

    const codeOwnersForGitSpec = getCodeOwnersForFilename(
      'packages/dd-trace/test/plugins/util/git.spec.js',
      codeOwnersFileEntries
    )

    assert.strictEqual(codeOwnersForGitSpec, JSON.stringify(['@datadog-dd-trace-js']))

    const codeOwnersForTestSpec = getCodeOwnersForFilename(
      'packages/dd-trace/test/plugins/util/test.spec.js',
      codeOwnersFileEntries
    )

    assert.strictEqual(codeOwnersForTestSpec, JSON.stringify(['@datadog-ci-app']))
  })

  it('does not let root-level fallbacks override integration test directories', () => {
    const codeOwnersFileEntries = [
      { pattern: '/*', owners: ['@datadog-lang-platform-js'] },
      { pattern: '/integration-tests/mocha/', owners: ['@datadog-ci-app-libraries'] },
      { pattern: '/integration-tests/playwright/', owners: ['@datadog-ci-app-libraries'] },
    ]

    const codeOwnersForMochaSpec = getCodeOwnersForFilename(
      'integration-tests/mocha/codeowners-root-pattern.spec.js',
      codeOwnersFileEntries
    )
    const codeOwnersForPlaywrightSpec = getCodeOwnersForFilename(
      'integration-tests/playwright/codeowners-root-pattern.spec.js',
      codeOwnersFileEntries
    )
    const codeOwnersForRootFile = getCodeOwnersForFilename('root-level-codeowners-test.js', codeOwnersFileEntries)

    assert.strictEqual(codeOwnersForMochaSpec, JSON.stringify(['@datadog-ci-app-libraries']))
    assert.strictEqual(codeOwnersForPlaywrightSpec, JSON.stringify(['@datadog-ci-app-libraries']))
    assert.strictEqual(codeOwnersForRootFile, JSON.stringify(['@datadog-lang-platform-js']))
  })

  it('matches directory patterns against descendants', () => {
    const codeOwnersFileEntries = [
      { pattern: '/packages/dd-trace/src/ci-visibility/', owners: ['@datadog-ci-app-libraries'] },
    ]

    const codeOwnersForCiVisibilityFile = getCodeOwnersForFilename(
      'packages/dd-trace/src/ci-visibility/exporters/agentless/writer.js',
      codeOwnersFileEntries
    )

    assert.strictEqual(codeOwnersForCiVisibilityFile, JSON.stringify(['@datadog-ci-app-libraries']))
  })

  it('matches wildcard directory patterns against descendants', () => {
    const codeOwnersFileEntries = [
      { pattern: '/*', owners: ['@datadog-lang-platform-js'] },
      { pattern: '/packages/datadog-plugin-*/', owners: ['@datadog-apm-idm-js'] },
    ]

    const codeOwnersForPluginFile = getCodeOwnersForFilename(
      'packages/datadog-plugin-http/test/codeowners-wildcard-directory.spec.js',
      codeOwnersFileEntries
    )

    assert.strictEqual(codeOwnersForPluginFile, JSON.stringify(['@datadog-apm-idm-js']))
  })

  it('does not match single-star wildcards across directories', () => {
    const codeOwnersFileEntries = [
      { pattern: '/packages/dd-trace/*/standalone', owners: ['@datadog-lang-platform-js'] },
    ]

    const codeOwnersForDirectMatch = getCodeOwnersForFilename(
      'packages/dd-trace/src/standalone/codeowners-single-star.js',
      codeOwnersFileEntries
    )
    const codeOwnersForNestedMismatch = getCodeOwnersForFilename(
      'packages/dd-trace/src/profiling/standalone/codeowners-single-star.js',
      codeOwnersFileEntries
    )

    assert.strictEqual(codeOwnersForDirectMatch, JSON.stringify(['@datadog-lang-platform-js']))
    assert.strictEqual(codeOwnersForNestedMismatch, null)
  })

  it('matches double-star patterns across directories', () => {
    const codeOwnersFileEntries = [
      { pattern: '/packages/**/dsm.spec.js', owners: ['@datadog-data-streams-monitoring'] },
      { pattern: '/packages/**/*.dsm.spec.js', owners: ['@datadog-data-streams-monitoring'] },
    ]

    const codeOwnersForDsmSpec = getCodeOwnersForFilename(
      'packages/datadog-plugin-kafkajs/test/dsm.spec.js',
      codeOwnersFileEntries
    )
    const codeOwnersForTopLevelDsmSpec = getCodeOwnersForFilename(
      'packages/dsm.spec.js',
      codeOwnersFileEntries
    )
    const codeOwnersForSuffixDsmSpec = getCodeOwnersForFilename(
      'packages/datadog-plugin-kafkajs/test/codeowners.dsm.spec.js',
      codeOwnersFileEntries
    )
    const codeOwnersForTopLevelSuffixDsmSpec = getCodeOwnersForFilename(
      'packages/codeowners.dsm.spec.js',
      codeOwnersFileEntries
    )

    assert.strictEqual(codeOwnersForDsmSpec, JSON.stringify(['@datadog-data-streams-monitoring']))
    assert.strictEqual(codeOwnersForTopLevelDsmSpec, JSON.stringify(['@datadog-data-streams-monitoring']))
    assert.strictEqual(codeOwnersForSuffixDsmSpec, JSON.stringify(['@datadog-data-streams-monitoring']))
    assert.strictEqual(codeOwnersForTopLevelSuffixDsmSpec, JSON.stringify(['@datadog-data-streams-monitoring']))
  })

  it('matches slashless patterns in any directory', () => {
    const codeOwnersFileEntries = [
      { pattern: 'github_event_payload.json', owners: ['@datadog-ci-app-libraries'] },
    ]

    const codeOwnersForNestedFixture = getCodeOwnersForFilename(
      'packages/dd-trace/test/plugins/util/fixtures/github_event_payload.json',
      codeOwnersFileEntries
    )

    assert.strictEqual(codeOwnersForNestedFixture, JSON.stringify(['@datadog-ci-app-libraries']))
  })

  it('matches patterns with middle slashes from the repository root', () => {
    const codeOwnersFileEntries = [
      { pattern: 'fixtures/codeowners-middle-slash.json', owners: ['@datadog-ci-app-libraries'] },
    ]

    const codeOwnersForRootFixture = getCodeOwnersForFilename(
      'fixtures/codeowners-middle-slash.json',
      codeOwnersFileEntries
    )
    const codeOwnersForNestedFixture = getCodeOwnersForFilename(
      'packages/dd-trace/test/plugins/util/fixtures/codeowners-middle-slash.json',
      codeOwnersFileEntries
    )

    assert.strictEqual(codeOwnersForRootFixture, JSON.stringify(['@datadog-ci-app-libraries']))
    assert.strictEqual(codeOwnersForNestedFixture, null)
  })

  it('does not let a root-level wildcard match nested files', () => {
    const codeOwnersFileEntries = [
      { pattern: '/*', owners: ['@datadog-lang-platform-js'] },
    ]

    const codeOwnersForNestedFile = getCodeOwnersForFilename(
      'packages/dd-trace/test/plugins/util/root-wildcard-check.spec.js',
      codeOwnersFileEntries
    )
    const codeOwnersForRootFile = getCodeOwnersForFilename(
      'root-wildcard-check.spec.js',
      codeOwnersFileEntries
    )

    assert.strictEqual(codeOwnersForNestedFile, null)
    assert.strictEqual(codeOwnersForRootFile, JSON.stringify(['@datadog-lang-platform-js']))
  })

  it('matches paths with Windows separators', () => {
    const codeOwnersFileEntries = [
      { pattern: '/integration-tests/vitest/', owners: ['@datadog-ci-app-libraries'] },
    ]

    const codeOwnersForWindowsPath = getCodeOwnersForFilename(
      'integration-tests\\vitest\\vitest.spec.js',
      codeOwnersFileEntries
    )

    assert.strictEqual(codeOwnersForWindowsPath, JSON.stringify(['@datadog-ci-app-libraries']))
  })
})

describe('coverage utils', () => {
  let coverage

  beforeEach(() => {
    delete require.cache[require.resolve('./fixtures/istanbul-map-fixture.json')]
    coverage = require('./fixtures/istanbul-map-fixture.json')
  })

  describe('getCoveredFilenamesFromCoverage', () => {
    it('returns the list of files the code coverage includes', () => {
      const coverageFiles = getCoveredFilenamesFromCoverage(coverage)
      assert.deepStrictEqual(coverageFiles, ['subtract.js', 'add.js'])
    })

    it('returns an empty list if coverage is empty', () => {
      const coverageFiles = getCoveredFilenamesFromCoverage({})
      assert.deepStrictEqual(coverageFiles, [])
    })
  })

  describe('resetCoverage', () => {
    it('resets the code coverage', () => {
      resetCoverage(coverage)
      const coverageFiles = getCoveredFilenamesFromCoverage(coverage)
      assert.deepStrictEqual(coverageFiles, [])
    })
  })

  describe('mergeCoverage', () => {
    it('copies the code coverage', () => {
      const newCoverageMap = istanbul.createCoverageMap()
      // At first it's different, then it is the same after copying
      assert.notStrictEqual(JSON.stringify(coverage), JSON.stringify(newCoverageMap.toJSON()))
      mergeCoverage(coverage, newCoverageMap)
      assert.strictEqual(JSON.stringify(coverage), JSON.stringify(newCoverageMap.toJSON()))
    })

    it('returns a copy that is not affected by other copies being reset', () => {
      const newCoverageMap = istanbul.createCoverageMap()

      assert.notStrictEqual(JSON.stringify(coverage), JSON.stringify(newCoverageMap.toJSON()))
      mergeCoverage(coverage, newCoverageMap)

      const originalCoverageJson = JSON.stringify(coverage)
      const copiedCoverageJson = JSON.stringify(newCoverageMap.toJSON())
      assert.strictEqual(originalCoverageJson, copiedCoverageJson)

      // The original coverage is reset
      resetCoverage(coverage)

      // The original coverage JSON representation changes
      assert.notStrictEqual(originalCoverageJson, JSON.stringify(coverage))

      // The original coverage JSON representation is not the same as the copied coverage
      assert.notStrictEqual(JSON.stringify(coverage), JSON.stringify(newCoverageMap.toJSON()))

      // The copied coverage remains the same after the original reset
      assert.strictEqual(copiedCoverageJson, JSON.stringify(newCoverageMap.toJSON()))
    })
  })
})

describe('metadata validation', () => {
  it('should remove invalid metadata', () => {
    const invalidMetadata1 = {
      [GIT_REPOSITORY_URL]: 'www.datadog.com',
      [CI_PIPELINE_URL]: 'www.datadog.com',
      [GIT_COMMIT_SHA]: 'abc123',
    }
    const invalidMetadata2 = {
      [GIT_REPOSITORY_URL]: 'htps://datadog.com/repo',
      [CI_PIPELINE_URL]: 'datadog.com',
      [GIT_COMMIT_SHA]: 'abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123',
    }
    const invalidMetadata3 = {
      [GIT_REPOSITORY_URL]: 'datadog.com',
      [CI_PIPELINE_URL]: 'datadog.com',
      [GIT_COMMIT_SHA]: 'abc123',
    }
    const invalidMetadata4 = {
      [GIT_REPOSITORY_URL]: 'datadog.com/repo.git',
      [CI_PIPELINE_URL]: 'www.datadog.com5',
      [GIT_COMMIT_SHA]: 'abc123',
    }
    const invalidMetadata5 = { [GIT_REPOSITORY_URL]: '', [CI_PIPELINE_URL]: '', [GIT_COMMIT_SHA]: '' }
    const invalidMetadatas = [invalidMetadata1, invalidMetadata2, invalidMetadata3, invalidMetadata4, invalidMetadata5]
    invalidMetadatas.forEach((invalidMetadata) => {
      assert.strictEqual(JSON.stringify(removeInvalidMetadata(invalidMetadata)), JSON.stringify({}))
    })
  })

  it('should keep valid metadata', () => {
    const validMetadata1 = {
      [GIT_REPOSITORY_URL]: 'https://datadoghq.com/myrepo/repo.git',
      [CI_PIPELINE_URL]: 'https://datadog.com',
      [GIT_COMMIT_SHA]: 'cb466452bfe18d4f6be2836c2a5551843013cf381234223920318230492823f3',
    }
    const validMetadata2 = {
      [GIT_REPOSITORY_URL]: 'http://datadoghq.com/myrepo/repo.git',
      [CI_PIPELINE_URL]: 'http://datadog.com',
      [GIT_COMMIT_SHA]: 'cb466452bfe18d4f6be2836c2a5551843013cf38',
    }
    const validMetadata3 = {
      [GIT_REPOSITORY_URL]: 'git@github.com:DataDog/dd-trace-js.git',
      [CI_PIPELINE_URL]: 'https://datadog.com/pipeline',
      [GIT_COMMIT_SHA]: 'cb466452bfe18d4f6be2836c2a5551843013cf381234223920318230492823f3',
    }
    const validMetadatas = [validMetadata1, validMetadata2, validMetadata3]
    validMetadatas.forEach((validMetadata) => {
      assert.strictEqual(JSON.stringify(removeInvalidMetadata(validMetadata)), JSON.stringify(validMetadata))
    })
  })
})

describe('parseAnnotations', () => {
  it('parses correctly shaped annotations', () => {
    const tags = parseAnnotations([
      {
        type: 'DD_TAGS[test.requirement]',
        description: 'high',
      },
      {
        type: 'DD_TAGS[test.responsible_team]',
        description: 'sales',
      },
    ])
    assert.deepStrictEqual(tags, {
      'test.requirement': 'high',
      'test.responsible_team': 'sales',
    })
  })

  it('does not crash with invalid arguments', () => {
    const tags = parseAnnotations([
      // @ts-expect-error: intentionally passing invalid types to test robustness
      {},
      // @ts-expect-error: intentionally passing invalid types to test robustness
      'invalid',
      { type: 'DD_TAGS', description: 'yeah' },
      { type: 'DD_TAGS[v', description: 'invalid' },
      { type: 'test.requirement', description: 'sure' },
    ])
    assert.deepStrictEqual(tags, {})
  })
})

describe('getIsFaultyEarlyFlakeDetection', () => {
  it('returns false if the absolute number of new suites is smaller or equal than the threshold', () => {
    const faultyThreshold = 30

    // Session has 50 tests and 25 are marked as new (50%): not faulty.
    const projectSuites = Array.from({ length: 50 }).map((_, i) => `test${i}.spec.js`)
    const knownSuites = Array.from({ length: 25 }).reduce((acc, _, i) => {
      acc[`test${i}.spec.js`] = ['test']
      return acc
    }, {})

    const isFaulty = getIsFaultyEarlyFlakeDetection(
      projectSuites,
      knownSuites,
      faultyThreshold
    )
    assert.strictEqual(isFaulty, false)

    // Session has 60 tests and 30 are marked as new (50%): not faulty.
    const projectSuites2 = Array.from({ length: 60 }).map((_, i) => `test${i}.spec.js`)
    const knownSuites2 = Array.from({ length: 30 }).reduce((acc, _, i) => {
      acc[`test${i}.spec.js`] = ['test']
      return acc
    }, {})
    const isFaulty2 = getIsFaultyEarlyFlakeDetection(
      projectSuites2,
      knownSuites2,
      faultyThreshold
    )
    assert.strictEqual(isFaulty2, false)
  })

  it('returns true if the percentage is above the threshold', () => {
    const faultyThreshold = 30

    // Session has 100 tests and 31 are marked as new (31%): faulty.
    const projectSuites = Array.from({ length: 100 }).map((_, i) => `test${i}.spec.js`)
    const knownSuites = Array.from({ length: 69 }).reduce((acc, _, i) => {
      acc[`test${i}.spec.js`] = ['test']
      return acc
    }, {})

    const isFaulty = getIsFaultyEarlyFlakeDetection(
      projectSuites,
      knownSuites,
      faultyThreshold
    )
    assert.strictEqual(isFaulty, true)
  })
})

describe('getNumFromKnownTests', () => {
  it('calculates the number of tests from the known tests', () => {
    const knownTests = {
      testModule: {
        'test1.spec.js': ['test1', 'test2'],
        'test2.spec.js': ['test3'],
      },
    }

    const numTests = getNumFromKnownTests(knownTests)
    assert.strictEqual(numTests, 3)
  })

  it('does not crash with empty dictionaries', () => {
    const knownTests = {}

    const numTests = getNumFromKnownTests(knownTests)
    assert.strictEqual(numTests, 0)
  })

  it('does not crash if known tests is undefined or null', () => {
    const numTestsUndefined = getNumFromKnownTests(undefined)
    assert.strictEqual(numTestsUndefined, 0)

    const numTestsNull = getNumFromKnownTests(null)
    assert.strictEqual(numTestsNull, 0)
  })
})

describe('getModifiedFilesFromDiff', () => {
  it('should parse git diff and return modified lines per file', () => {
    const diff = `diff --git a/test/file1.js b/test/file1.js
index 1234567..89abcde 100644
--- a/test/file1.js
+++ b/test/file1.js
@@ -2 +2 @@
-line2
+line2 modified
@@ -4,0 +4,1 @@
+new line
diff --git a/test/file2.js b/test/file2.js
index 1234567..89abcde 100644
--- a/test/file2.js
+++ b/test/file2.js
@@ -5,0 +5,1 @@
+new line`

    const expected = {
      'test/file1.js': [2, 4],
      'test/file2.js': [5],
    }

    assert.deepStrictEqual(getModifiedFilesFromDiff(diff), expected)
  })

  it('should return null for empty or invalid diff', () => {
    assert.strictEqual(getModifiedFilesFromDiff(''), null)
    assert.strictEqual(getModifiedFilesFromDiff(null), null)
    assert.strictEqual(getModifiedFilesFromDiff(undefined), null)
  })

  it('should handle multiple line changes in a single hunk', () => {
    const diff = `diff --git a/test/file.js b/test/file.js
index 1234567..89abcde 100644
--- a/test/file.js
+++ b/test/file.js
@@ -2 +2 @@
-line2
+line2 modified
@@ -4,0 +4,1 @@
+new line
@@ -6,0 +6,1 @@
+another new line`

    const expected = {
      'test/file.js': [2, 4, 6],
    }

    assert.deepStrictEqual(getModifiedFilesFromDiff(diff), expected)
  })
})

describe('isModifiedTest', () => {
  describe('when tests come from local diff', () => {
    const testFramework = 'jest'

    it('should return true when test lines overlap with modified lines', () => {
      const modifiedFiles = {
        'test/file.js': [2, 4, 6],
      }
      // Overlaps with lines 2, 4, 6
      assert.strictEqual(isModifiedTest('test/file.js', 1, 3, modifiedFiles, testFramework), true)
      assert.strictEqual(isModifiedTest('test/file.js', 3, 5, modifiedFiles, testFramework), true)
      assert.strictEqual(isModifiedTest('test/file.js', 5, 7, modifiedFiles, testFramework), true)
    })

    it('should return false when test lines do not overlap with modified lines', () => {
      const modifiedFiles = {
        'test/file.js': [2, 4, 6],
      }
      assert.strictEqual(isModifiedTest('test/file.js', 7, 9, modifiedFiles, testFramework), false)
      assert.strictEqual(isModifiedTest('test/file.js', 0, 1, modifiedFiles, testFramework), false)
    })

    it('should return false when file is not in modified tests', () => {
      const modifiedFiles = {
        'test/file.js': [2, 4, 6],
      }
      assert.strictEqual(isModifiedTest('test/other.js', 1, 3, modifiedFiles, testFramework), false)
    })

    it('should handle single line tests', () => {
      const modifiedFiles = {
        'test/file.js': [2, 4, 6],
      }
      assert.strictEqual(isModifiedTest('test/file.js', 2, 2, modifiedFiles, testFramework), true)
      assert.strictEqual(isModifiedTest('test/file.js', 3, 3, modifiedFiles, testFramework), false)
    })
  })

  describe('when tests frameworks do not support granular impacted tests', () => {
    const testFramework = 'playwright'

    it('should return true when test file is in modifiedFiles', () => {
      const modifiedFiles = {
        'test/file.js': [2, 4, 6],
        'test/other.js': [2, 4, 6],
      }
      assert.strictEqual(isModifiedTest('test/file.js', 1, 10, modifiedFiles, testFramework), true)
      assert.strictEqual(isModifiedTest('test/other.js', 1, 10, modifiedFiles, testFramework), true)
    })

    it('should return false when test file is not in modifiedFiles', () => {
      const modifiedFiles = {
        'test/file.js': [2, 4, 6],
      }
      assert.strictEqual(isModifiedTest('test/other.js', 1, 10, modifiedFiles, testFramework), false)
    })
  })

  it('should handle empty modifiedFiles object', () => {
    assert.strictEqual(isModifiedTest('test/file.js', 1, 10, {}, 'jest'), false)
  })
})

describe('getPullRequestBaseBranch', () => {
  context('there is a pull request base branch', () => {
    it('returns base commit SHA to compare against ', () => {
      const getMergeBaseStub = sinon.stub()
      getMergeBaseStub.returns('1234af')
      const checkAndFetchBranchStub = sinon.stub()
      const getLocalBranchesStub = sinon.stub()
      const { getPullRequestBaseBranch } = proxyquire('../../../src/plugins/util/test', {
        './git': {
          getGitRemoteName: () => 'origin',
          getSourceBranch: () => 'feature-branch',
          getMergeBase: getMergeBaseStub,
          checkAndFetchBranch: checkAndFetchBranchStub,
          getLocalBranches: getLocalBranchesStub,
        },
      })
      const baseBranch = getPullRequestBaseBranch('trunk')
      assert.strictEqual(baseBranch, '1234af')
      sinon.assert.calledWith(checkAndFetchBranchStub, 'trunk', 'origin')
      sinon.assert.calledWith(getMergeBaseStub, 'trunk', 'feature-branch')
      sinon.assert.notCalled(getLocalBranchesStub)
    })
  })

  context('there is no pull request base branch', () => {
    it('returns the best base branch SHA from local branches', () => {
      const checkAndFetchBranchStub = sinon.stub()
      const getLocalBranchesStub = sinon.stub().returns(['trunk', 'master', 'feature-branch'])

      const getMergeBaseStub = sinon.stub()
      getMergeBaseStub.withArgs('trunk', 'feature-branch').returns('1234af')
      getMergeBaseStub.withArgs('master', 'feature-branch').returns('fa4321')

      const getCountsStub = sinon.stub()
      getCountsStub.withArgs('trunk', 'feature-branch').returns({ ahead: 0, behind: 0 })
      // master should be chosen because even though it has the same "ahead" value, it is a default branch
      getCountsStub.withArgs('master', 'feature-branch').returns({ ahead: 0, behind: 1 })

      const { getPullRequestBaseBranch, POSSIBLE_BASE_BRANCHES } = proxyquire('../../../src/plugins/util/test', {
        './git': {
          getGitRemoteName: () => 'origin',
          getSourceBranch: () => 'feature-branch',
          getMergeBase: getMergeBaseStub,
          checkAndFetchBranch: checkAndFetchBranchStub,
          getLocalBranches: getLocalBranchesStub,
          getCounts: getCountsStub,
        },
      })
      const baseBranch = getPullRequestBaseBranch()
      assert.strictEqual(baseBranch, 'fa4321')

      POSSIBLE_BASE_BRANCHES.forEach((baseBranch) => {
        sinon.assert.calledWith(checkAndFetchBranchStub, baseBranch, 'origin')
      })
      sinon.assert.calledWith(getLocalBranchesStub, 'origin')
      sinon.assert.calledWith(getMergeBaseStub, 'master', 'feature-branch')
      sinon.assert.calledWith(getMergeBaseStub, 'trunk', 'feature-branch')
      sinon.assert.calledWith(getCountsStub, 'master', 'feature-branch')
      sinon.assert.calledWith(getCountsStub, 'trunk', 'feature-branch')
    })
  })
})

describe('checkShaDiscrepancies', () => {
  const incrementCountMetricStub = sinon.stub()

  it('return true if the CI/Git Client repository URL is different from the user provided repository URL', () => {
    const ciMetadata = {
      [GIT_COMMIT_SHA]: '1234af',
      [GIT_REPOSITORY_URL]: 'https://github.com/datadog/dd-trace-js.git',
    }
    const userProvidedGitMetadata = {
      [GIT_COMMIT_SHA]: '1234af',
      [GIT_REPOSITORY_URL]: 'Bad URL',
    }
    const getGitInformationDiscrepancyStub = sinon.stub()
    getGitInformationDiscrepancyStub.returns({
      gitRepositoryUrl: 'Bad URL 2',
      gitCommitSHA: '1234af',
    })
    const { checkShaDiscrepancies } = proxyquire('../../../src/plugins/util/test', {
      './git': {
        getGitInformationDiscrepancy: getGitInformationDiscrepancyStub,
      },
      '../../ci-visibility/telemetry': {
        incrementCountMetric: incrementCountMetricStub,
      },
    })

    checkShaDiscrepancies(ciMetadata, userProvidedGitMetadata)

    const expectedCalls = [
      { type: 'repository_discrepancy', expectedProvider: 'user_supplied', discrepantProvider: 'git_client' },
      { type: 'repository_discrepancy', expectedProvider: 'user_supplied', discrepantProvider: 'ci_provider' },
      { type: 'repository_discrepancy', expectedProvider: 'ci_provider', discrepantProvider: 'git_client' },
    ]

    expectedCalls.forEach(({ type, expectedProvider, discrepantProvider }) => {
      sinon.assert.calledWith(incrementCountMetricStub, TELEMETRY_GIT_COMMIT_SHA_DISCREPANCY, {
        type,
        expected_provider: expectedProvider,
        discrepant_provider: discrepantProvider,
      })
    })
    sinon.assert.calledWith(incrementCountMetricStub, TELEMETRY_GIT_SHA_MATCH, { matched: false })
  })

  it('return true if the CI/Git Client commit SHA is different from the user provided commit SHA', () => {
    incrementCountMetricStub.resetHistory()
    const ciMetadata = {
      [GIT_COMMIT_SHA]: 'abcd',
      [GIT_REPOSITORY_URL]: 'https://github.com/datadog/dd-trace-js.git',
    }
    const userProvidedGitMetadata = {
      [GIT_COMMIT_SHA]: 'efgh',
      [GIT_REPOSITORY_URL]: 'https://github.com/datadog/dd-trace-js.git',
    }
    const getGitInformationDiscrepancyStub = sinon.stub()
    getGitInformationDiscrepancyStub.returns({
      gitRepositoryUrl: 'https://github.com/datadog/dd-trace-js.git',
      gitCommitSHA: 'ijkl',
    })
    const { checkShaDiscrepancies } = proxyquire('../../../src/plugins/util/test', {
      './git': {
        getGitInformationDiscrepancy: getGitInformationDiscrepancyStub,
      },
      '../../ci-visibility/telemetry': {
        incrementCountMetric: incrementCountMetricStub,
      },
    })

    checkShaDiscrepancies(ciMetadata, userProvidedGitMetadata)

    const expectedCalls = [
      { type: 'commit_discrepancy', expectedProvider: 'user_supplied', discrepantProvider: 'git_client' },
      { type: 'commit_discrepancy', expectedProvider: 'user_supplied', discrepantProvider: 'ci_provider' },
      { type: 'commit_discrepancy', expectedProvider: 'ci_provider', discrepantProvider: 'git_client' },
    ]

    expectedCalls.forEach(({ type, expectedProvider, discrepantProvider }) => {
      sinon.assert.calledWith(incrementCountMetricStub, TELEMETRY_GIT_COMMIT_SHA_DISCREPANCY, {
        type,
        expected_provider: expectedProvider,
        discrepant_provider: discrepantProvider,
      })
    })
    sinon.assert.calledWith(incrementCountMetricStub, TELEMETRY_GIT_SHA_MATCH, { matched: false })
  })

  it('increment TELEMETRY_GIT_SHA_MATCH with match: true when all values match', () => {
    incrementCountMetricStub.resetHistory()
    const ciMetadata = {
      [GIT_COMMIT_SHA]: '1234af',
      [GIT_REPOSITORY_URL]: 'https://github.com/datadog/dd-trace-js.git',
    }
    const userProvidedGitMetadata = {
      [GIT_COMMIT_SHA]: '1234af',
      [GIT_REPOSITORY_URL]: 'https://github.com/datadog/dd-trace-js.git',
    }
    const getGitInformationDiscrepancyStub = sinon.stub()
    getGitInformationDiscrepancyStub.returns({
      gitRepositoryUrl: 'https://github.com/datadog/dd-trace-js.git',
      gitCommitSHA: '1234af',
    })
    const { checkShaDiscrepancies } = proxyquire('../../../src/plugins/util/test', {
      './git': {
        getGitInformationDiscrepancy: getGitInformationDiscrepancyStub,
      },
      '../../ci-visibility/telemetry': {
        incrementCountMetric: incrementCountMetricStub,
      },
    })

    checkShaDiscrepancies(ciMetadata, userProvidedGitMetadata)

    sinon.assert.calledWith(incrementCountMetricStub, TELEMETRY_GIT_SHA_MATCH, { matched: true })
  })
})
