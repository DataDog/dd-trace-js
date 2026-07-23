'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const proxyquire = require('proxyquire').noPreserveCache()

const {
  getDebugAwareDiagnosis,
  getBasicReportingCommand,
  getMissingEventDiagnosis,
  refineBasicReportingFailure,
  shouldRunDebugRerun,
  summarizeTestOutput,
} = require('../../../../ci/test-optimization-validation/scenarios/basic-reporting')
const {
  tailInterestingLines,
} = require('../../../../ci/test-optimization-validation/scenarios/helpers')

describe('test optimization basic reporting diagnosis', () => {
  it('uses existingTestCommand for direct-initialization Basic Reporting', () => {
    const existingTestCommand = { argv: ['npm', 'test'] }

    assert.strictEqual(getBasicReportingCommand({
      existingTestCommand,
    }), existingTestCommand)
  })

  it('reruns the clean command and reports an unstable baseline when its exit changes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-basic-reporting-confirmation-'))
    let cleanRuns = 0
    const { runBasicReporting } = getBasicReportingWithExitMismatch({
      cleanExitCode: 1,
      onCleanRun: () => cleanRuns++,
    })
    const framework = getExitMismatchFramework(root)

    try {
      const result = await runBasicReporting({ framework, out: root, options: { repositoryRoot: root } })

      assert.strictEqual(cleanRuns, 1)
      assert.strictEqual(result.status, 'error')
      assert.strictEqual(result.evidence.validationIncomplete, true)
      assert.strictEqual(result.evidence.cleanConfirmation.exitMatchesPreflight, false)
      assert.match(result.diagnosis, /non-Datadog baseline was not stable/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports a possible compatibility issue when both clean exits agree', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-basic-reporting-confirmation-'))
    const { runBasicReporting } = getBasicReportingWithExitMismatch({ cleanExitCode: 0 })
    const framework = getExitMismatchFramework(root)

    try {
      const result = await runBasicReporting({ framework, out: root, options: { repositoryRoot: root } })

      assert.strictEqual(result.status, 'fail')
      assert.strictEqual(result.evidence.cleanConfirmation.exitMatchesPreflight, true)
      assert.match(result.diagnosis, /may indicate a dd-trace compatibility issue/)
      assert.doesNotMatch(result.diagnosis, /pre-existing/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses equivalent direct-runner reporting to diagnose a project wrapper propagation failure', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-basic-reporting-isolation-'))
    const { runBasicReporting } = getBasicReportingWithIsolation({ isolationHasEvents: true })
    const framework = getIsolationFramework(root)

    try {
      const result = await runBasicReporting({ framework, out: root, options: { repositoryRoot: root } })

      assert.strictEqual(result.status, 'fail')
      assert.strictEqual(result.evidence.foundationalReportingEstablished, true)
      assert.strictEqual(result.evidence.reportingPath, 'validator-direct-isolation')
      assert.strictEqual(result.evidence.isolation.foundationalReportingEstablished, true)
      assert.match(result.diagnosis, /project wrapper likely does not propagate the required initialization/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports a possible adapter issue when direct isolation initializes without test events', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-basic-reporting-isolation-'))
    const { runBasicReporting } = getBasicReportingWithIsolation({ isolationHasEvents: false })
    const framework = getIsolationFramework(root)

    try {
      const result = await runBasicReporting({ framework, out: root, options: { repositoryRoot: root } })

      assert.strictEqual(result.status, 'fail')
      assert.strictEqual(result.evidence.foundationalReportingEstablished, false)
      assert.strictEqual(result.evidence.reportingPath, 'none')
      assert.strictEqual(result.evidence.isolation.offlineExporterInitialized, true)
      assert.match(result.diagnosis, /may indicate a dd-trace adapter or compatibility issue/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps isolation unavailable as incomplete foundational evidence', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-basic-reporting-isolation-'))
    const { runBasicReporting } = getBasicReportingWithIsolation({
      isolationHasEvents: false,
      isolationPreflightOk: false,
    })
    const framework = getIsolationFramework(root)

    try {
      const result = await runBasicReporting({ framework, out: root, options: { repositoryRoot: root } })

      assert.strictEqual(result.status, 'fail')
      assert.strictEqual(result.evidence.foundationalReportingEstablished, false)
      assert.strictEqual(result.evidence.reportingPath, 'none')
      assert.strictEqual(result.evidence.isolationUnavailable, true)
      assert.strictEqual(result.evidence.isolation, undefined)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not replace an instrumented exit failure with an isolation diagnosis', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-basic-reporting-isolation-'))
    const validation = getBasicReportingWithIsolation({
      isolationHasEvents: true,
      primaryExitCode: 1,
    })
    const framework = getIsolationFramework(root)

    try {
      const result = await validation.runBasicReporting({
        framework,
        out: root,
        options: { repositoryRoot: root },
      })

      assert.strictEqual(validation.getExecutionCounts().cleanConfirmations, 1)
      assert.strictEqual(validation.getExecutionCounts().isolationPreflights, 0)
      assert.strictEqual(result.evidence.foundationalReportingEstablished, false)
      assert.ok(result.evidence.cleanConfirmation)
      assert.doesNotMatch(result.diagnosis, /project wrapper likely does not propagate/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not attempt isolation after an instrumented timeout', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-basic-reporting-isolation-'))
    const validation = getBasicReportingWithIsolation({
      isolationHasEvents: true,
      primaryTimedOut: true,
    })

    try {
      const result = await validation.runBasicReporting({
        framework: getIsolationFramework(root),
        out: root,
        options: { repositoryRoot: root },
      })

      assert.strictEqual(validation.getExecutionCounts().isolationPreflights, 0)
      assert.strictEqual(result.evidence.isolationEligible, false)
      assert.doesNotMatch(result.diagnosis, /project wrapper likely does not propagate/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses direct isolation when the project command does not load authoritative settings', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-basic-reporting-isolation-'))
    const validation = getBasicReportingWithIsolation({
      isolationHasEvents: true,
      primarySettingsLoaded: false,
    })

    try {
      const result = await validation.runBasicReporting({
        framework: getIsolationFramework(root),
        out: root,
        options: { repositoryRoot: root },
      })

      assert.strictEqual(validation.getExecutionCounts().isolationPreflights, 1)
      assert.strictEqual(validation.getExecutionCounts().debugReruns, 1)
      assert.strictEqual(result.status, 'fail')
      assert.strictEqual(result.evidence.isolationEligible, true)
      assert.strictEqual(result.evidence.foundationalReportingEstablished, true)
      assert.strictEqual(result.evidence.localDiagnosis.kind, 'offline-settings-not-loaded')
      assert.match(result.diagnosis, /project wrapper likely does not propagate/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('debug-reruns an exporter initialization failure before trying direct isolation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-basic-reporting-exporter-'))
    const validation = getBasicReportingWithIsolation({
      isolationHasEvents: false,
      primaryExporterInitialized: false,
    })

    try {
      const result = await validation.runBasicReporting({
        framework: getIsolationFramework(root),
        out: root,
        options: { repositoryRoot: root },
      })

      assert.strictEqual(validation.getExecutionCounts().debugReruns, 2)
      assert.strictEqual(validation.getExecutionCounts().isolationPreflights, 1)
      assert.strictEqual(result.status, 'error')
      assert.strictEqual(result.evidence.domain, 'test_optimization')
      assert.strictEqual(result.evidence.localDiagnosis.kind, 'offline-exporter-not-initialized')
      assert.strictEqual(result.evidence.debugRerun.ran, true)
      assert.match(result.diagnosis, /direct-runner isolation check did not report a complete event hierarchy/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not call a Cucumber source-checkout isolation result an adapter bug', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-basic-reporting-cucumber-source-'))
    const validation = getBasicReportingWithIsolation({ isolationHasEvents: false })
    const framework = getIsolationFramework(root)
    framework.id = 'cucumber:root'
    framework.framework = 'cucumber'
    framework.project = { name: '@cucumber/cucumber', root }
    framework.isolationTestCandidate.command.argv = [
      process.execPath,
      path.join(root, 'bin', 'cucumber.js'),
    ]

    try {
      const result = await validation.runBasicReporting({
        framework,
        out: root,
        options: { repositoryRoot: root },
      })

      assert.strictEqual(result.evidence.isolationRepresentativeness.representative, false)
      assert.match(result.diagnosis, /not a reliable reproduction of customer Cucumber instrumentation/)
      assert.match(result.diagnosis, /installed under node_modules/)
      assert.doesNotMatch(result.diagnosis, /may indicate a dd-trace adapter/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('requires authoritative isolation settings before establishing reporting', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-basic-reporting-isolation-'))
    const validation = getBasicReportingWithIsolation({
      isolationHasEvents: true,
      isolationSettingsLoaded: false,
    })

    try {
      const result = await validation.runBasicReporting({
        framework: getIsolationFramework(root),
        out: root,
        options: { repositoryRoot: root },
      })

      assert.strictEqual(result.evidence.foundationalReportingEstablished, false)
      assert.strictEqual(result.evidence.isolationStatus, 'error')
      assert.strictEqual(result.evidence.isolation.settingsLoadedFromCache, false)
      assert.doesNotMatch(result.diagnosis, /project wrapper likely does not propagate/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('clean-confirms a nonzero isolation exit even when all events were emitted', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-basic-reporting-isolation-'))
    const validation = getBasicReportingWithIsolation({
      isolationExitCode: 1,
      isolationHasEvents: true,
    })

    try {
      const result = await validation.runBasicReporting({
        framework: getIsolationFramework(root),
        out: root,
        options: { repositoryRoot: root },
      })

      assert.strictEqual(validation.getExecutionCounts().cleanConfirmations, 1)
      assert.strictEqual(result.evidence.foundationalReportingEstablished, false)
      assert.strictEqual(result.evidence.isolationStatus, 'fail')
      assert.strictEqual(result.evidence.isolation.cleanConfirmation.exitMatchesPreflight, true)
      assert.match(result.evidence.isolationDiagnosis, /may indicate a dd-trace compatibility issue/)
      assert.match(result.diagnosis, /direct-runner isolation emitted a complete event hierarchy/)
      assert.match(result.diagnosis, /may indicate a dd-trace compatibility issue/)
      assert.doesNotMatch(result.diagnosis, /project wrapper likely does not propagate/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses the isolation command associated with the selected project fallback', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-basic-reporting-isolation-'))
    const validation = getBasicReportingWithIsolation({ isolationHasEvents: true })
    const framework = getIsolationFramework(root)
    const secondSource = path.join(root, 'test', 'fallback.spec.js')
    framework.preflight.selectedCandidateIndex = 1
    framework.isolationTestCandidates = [
      { ...framework.isolationTestCandidate, primaryCandidateIndex: 0 },
      {
        ...framework.isolationTestCandidate,
        primaryCandidateIndex: 1,
        sourceFile: secondSource,
        equivalence: {
          ...framework.isolationTestCandidate.equivalence,
          sourceFile: secondSource,
        },
      },
    ]

    try {
      await validation.runBasicReporting({ framework, out: root, options: { repositoryRoot: root } })

      assert.strictEqual(validation.getExecutionCounts().selectedIsolationSource, secondSource)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('explains Vitest benchmark mode without scheduling a debug rerun', () => {
    const eventLevelFailure = getMissingEventDiagnosis({
      framework: {
        framework: 'vitest',
      },
      result: {
        command: 'vitest bench --run src/parser.bench.ts',
        stdout: ' BENCH  Summary\n',
        stderr: 'Benchmarking is an experimental feature.\n',
      },
      evidence: {
        testSessionEvents: 1,
        testModuleEvents: 1,
        testSuiteEvents: 1,
        testEvents: 0,
      },
    })

    assert.strictEqual(eventLevelFailure.kind, 'vitest-benchmark')
    assert.match(eventLevelFailure.summary, /benchmark mode/)
    assert.deepStrictEqual(eventLevelFailure.missingLevels, ['test'])
    assert.strictEqual(shouldRunDebugRerun(eventLevelFailure, { exitCode: 0, timedOut: false }), false)
  })

  it('schedules a debug rerun when a successful command misses test events for an unknown reason', () => {
    const eventLevelFailure = getMissingEventDiagnosis({
      framework: {
        framework: 'vitest',
      },
      result: {
        command: 'vitest run src/parser.test.ts',
        stdout: '',
        stderr: '',
      },
      evidence: {
        testSessionEvents: 1,
        testModuleEvents: 1,
        testSuiteEvents: 1,
        testEvents: 0,
      },
    })

    assert.strictEqual(eventLevelFailure.kind, 'missing-test-events')
    assert.match(eventLevelFailure.recommendation, /debug rerun/)
    assert.strictEqual(shouldRunDebugRerun(eventLevelFailure, { exitCode: 0, timedOut: false }), true)
  })

  it('explains missing Jest test events from a custom runner in config', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-jest-runner-'))
    const configFile = path.join(root, 'jest.config.js')

    try {
      fs.writeFileSync(configFile, 'module.exports = { runner: "jest-light-runner" }\n')

      const eventLevelFailure = getMissingEventDiagnosis({
        framework: {
          framework: 'jest',
          project: {
            configFiles: [configFile],
          },
        },
        result: {
          command: 'node ./node_modules/.bin/jest --ci',
          stdout: 'PASS packages/example.test.js\n',
          stderr: '',
        },
        evidence: {
          testSessionEvents: 1,
          testModuleEvents: 1,
          testSuiteEvents: 0,
          testEvents: 0,
        },
      })

      assert.strictEqual(eventLevelFailure.kind, 'custom-jest-runner')
      assert.strictEqual(eventLevelFailure.customTestRunner.name, 'jest-light-runner')
      assert.strictEqual(eventLevelFailure.customTestRunner.source, configFile)
      assert.match(eventLevelFailure.summary, /custom Jest-compatible runner: `jest-light-runner`/)
      assert.match(eventLevelFailure.recommendation, /standard Jest runner/)
      assert.deepStrictEqual(eventLevelFailure.missingLevels, ['test_suite_end', 'test'])
      assert.strictEqual(shouldRunDebugRerun(eventLevelFailure, { exitCode: 0, timedOut: false }), false)
    } finally {
      fs.rmSync(root, { force: true, recursive: true })
    }
  })

  it('explains missing Jest test events from package.json custom runner config', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-jest-package-runner-'))
    const packageJson = path.join(root, 'package.json')

    try {
      fs.writeFileSync(packageJson, `${JSON.stringify({ jest: { runner: 'jest-runner-eslint' } }, null, 2)}\n`)

      const eventLevelFailure = getMissingEventDiagnosis({
        framework: {
          framework: 'jest',
          project: {
            packageJson,
          },
        },
        result: {
          command: 'npm test',
          stdout: 'PASS lint.test.js\n',
          stderr: '',
        },
        evidence: {
          testSessionEvents: 1,
          testModuleEvents: 1,
          testSuiteEvents: 1,
          testEvents: 0,
        },
      })

      assert.strictEqual(eventLevelFailure.kind, 'custom-jest-runner')
      assert.strictEqual(eventLevelFailure.customTestRunner.name, 'jest-runner-eslint')
      assert.strictEqual(eventLevelFailure.customTestRunner.source, packageJson)
      assert.deepStrictEqual(eventLevelFailure.missingLevels, ['test'])
    } finally {
      fs.rmSync(root, { force: true, recursive: true })
    }
  })

  it('explains framework source-tree runner commands', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-mocha-source-'))

    try {
      fs.mkdirSync(path.join(root, 'lib'))
      fs.writeFileSync(path.join(root, 'lib/mocha.cjs'), '')
      fs.writeFileSync(path.join(root, 'lib/runner.cjs'), '')

      const eventLevelFailure = getMissingEventDiagnosis({
        framework: {
          framework: 'mocha',
          project: {
            name: 'mocha',
            root,
          },
        },
        result: {
          command: 'npm run test-smoke',
          stdout: '> node ./bin/mocha.js --no-config test/smoke/smoke.spec.cjs\n  1 passing (1ms)',
          stderr: '',
        },
        evidence: {
          testSessionEvents: 0,
          testModuleEvents: 0,
          testSuiteEvents: 0,
          testEvents: 0,
        },
      })

      assert.strictEqual(eventLevelFailure.kind, 'framework-source-tree-runner')
      assert.match(eventLevelFailure.summary, /framework source tree/)
      assert.match(eventLevelFailure.recommendation, /installed supported framework package/)
    } finally {
      fs.rmSync(root, { force: true, recursive: true })
    }
  })

  it('extracts concise test output summaries', () => {
    assert.deepStrictEqual(summarizeTestOutput(`
      sample suite
        ✔ sample test

      1 passing (2ms)
    `), ['      1 passing (2ms)'])
  })

  it('omits encoded payloads and truncates long debug tail lines', () => {
    const lines = tailInterestingLines([
      `Encoding payload: ${'secret-payload'.repeat(100)}`,
      `Error: ${'x'.repeat(600)}`,
      'Tests 4 passed (4)',
    ].join('\n'))

    assert.strictEqual(lines.length, 2)
    assert.strictEqual(lines[0].length, 503)
    assert.match(lines[0], /\.\.\.$/)
    assert.strictEqual(lines[1], 'Tests 4 passed (4)')
  })

  it('explains when tests ran but debug output shows package-manager initialization only', () => {
    const diagnosis = getDebugAwareDiagnosis('No Test Optimization test events reached the event artifact.', {
      commandOutputSummary: ['1 passing (2ms)'],
      eventLevelFailure: {
        kind: 'no-test-optimization-events',
      },
      preflight: {
        observedTestCount: 1,
      },
      debugRerun: {
        ran: true,
        testSessionEvents: 0,
        testModuleEvents: 0,
        testSuiteEvents: 0,
        testEvents: 0,
        debugLines: [
          'dd-trace is not initialized in a package manager.',
        ],
        stdoutExcerpt: [
          '1 passing (1ms)',
        ],
      },
    })

    assert.strictEqual(diagnosis.kind, 'tests-ran-tracer-not-initialized')
    assert.match(diagnosis.summary, /selected command ran tests/)
    assert.match(diagnosis.summary, /dd-trace is not initialized in a package manager/)
    assert.deepStrictEqual(diagnosis.signals.testOutputSummary, ['1 passing (2ms)', '1 passing (1ms)'])
  })

  for (const output of ['1 failing', 'Tests: 1 failed, 1 total']) {
    it(`recognizes failed-only output as evidence that tests ran: ${output}`, () => {
      const diagnosis = getDebugAwareDiagnosis('No Test Optimization test events reached the event artifact.', {
        commandOutputSummary: [output],
        eventLevelFailure: { kind: 'no-test-optimization-events' },
        debugRerun: {
          ran: true,
          testSessionEvents: 0,
          testModuleEvents: 0,
          testSuiteEvents: 0,
          testEvents: 0,
          debugLines: ['dd-trace is not initialized in a package manager.'],
          stdoutExcerpt: [],
        },
      })

      assert.strictEqual(diagnosis.kind, 'tests-ran-tracer-not-initialized')
    })
  }

  it('reports a dd-trace preload dependency failure before missing-event diagnosis', () => {
    const diagnosis = getMissingEventDiagnosis({
      framework: { framework: 'vitest' },
      result: {
        command: 'pnpm test',
        stdout: '',
        stderr: "Error: Cannot find module 'dc-polyfill'\nRequire stack:\n- node_modules/dd-trace/ci/init.js\n" +
          '- node:internal/preload',
      },
      evidence: {
        commandFailure: {
          buildErrors: ["Error: Cannot find module 'dc-polyfill'"],
          summary: 'The selected test command failed during project setup/build.',
        },
        testSessionEvents: 0,
        testModuleEvents: 0,
        testSuiteEvents: 0,
        testEvents: 0,
      },
    })

    assert.strictEqual(diagnosis.kind, 'dd-trace-preload-failed')
    assert.match(diagnosis.summary, /preload failed before tests started/)
    assert.match(diagnosis.summary, /No Test Optimization conclusion was reached/)
    assert.doesNotMatch(diagnosis.summary, /selected command ran tests/i)

    const failure = refineBasicReportingFailure({
      status: 'fail',
      diagnosis: diagnosis.summary,
      evidence: { eventLevelFailure: diagnosis },
    })
    assert.strictEqual(failure.status, 'error')
  })
})

function getExitMismatchFramework (root) {
  return {
    id: 'mocha:root',
    framework: 'mocha',
    existingTestCommand: {
      cwd: root,
      argv: [process.execPath, '-e', 'process.exit(0)'],
    },
    preflight: {
      ran: true,
      exitCode: 0,
      maxTestCount: 1,
      observedTestCount: 1,
    },
  }
}

function getBasicReportingWithExitMismatch ({ cleanExitCode, onCleanRun = () => {} }) {
  return proxyquire('../../../../ci/test-optimization-validation/scenarios/basic-reporting', {
    '../command-runner': {
      runCommand: async () => {
        onCleanRun()
        return {
          artifacts: {},
          exitCode: cleanExitCode,
          stderr: '',
          stdout: '1 passing',
          timedOut: false,
        }
      },
    },
    './helpers': {
      basicEventEvidence: () => ({
        testSessionEvents: 1,
        testModuleEvents: 1,
        testSuiteEvents: 1,
        testEvents: 1,
      }),
      failWithDebugRerun: async options => ({
        artifacts: [],
        diagnosis: options.diagnosis,
        evidence: options.evidence,
        frameworkId: options.framework.id,
        scenario: options.scenarioName,
        status: 'fail',
      }),
      hasAllBasicEventTypes: () => true,
      runInstrumentedCommand: async ({ out }) => ({
        events: [],
        offline: {
          initialized: true,
          inputs: { settings: { status: 'loaded' } },
          summary: { errors: [] },
        },
        outDir: path.join(out, 'basic-reporting'),
        result: {
          exitCode: 1,
          stderr: '',
          stdout: '1 failing',
          timedOut: false,
        },
      }),
    },
  })
}

function getIsolationFramework (root) {
  return {
    id: 'mocha:root',
    framework: 'mocha',
    existingTestCommand: {
      cwd: root,
      argv: [process.execPath, '-e', 'console.log("1 passing")'],
    },
    isolationTestCandidate: {
      origin: 'validator-direct',
      sourceFile: path.join(root, 'test', 'example.spec.js'),
      maxTestCount: 1,
      command: {
        cwd: root,
        argv: [process.execPath, '-e', 'console.log("1 passing")'],
      },
      equivalence: {
        sourceFile: path.join(root, 'test', 'example.spec.js'),
        runnerMode: 'mocha',
        configFiles: [],
      },
    },
    preflight: {
      ran: true,
      exitCode: 0,
      maxTestCount: 1,
      observedTestCount: 1,
    },
  }
}

function getBasicReportingWithIsolation ({
  isolationExitCode = 0,
  isolationExporterInitialized = true,
  isolationHasEvents,
  isolationPreflightOk = true,
  isolationSettingsLoaded = true,
  primaryExitCode = 0,
  primaryExporterInitialized = true,
  primarySettingsLoaded = true,
  primaryTimedOut = false,
}) {
  let cleanConfirmations = 0
  let debugReruns = 0
  let isolationPreflights = 0
  let selectedIsolationSource
  const basicReporting = proxyquire('../../../../ci/test-optimization-validation/scenarios/basic-reporting', {
    '../command-runner': {
      runCommand: async () => {
        cleanConfirmations++
        return {
          artifacts: {},
          exitCode: 0,
          stderr: '',
          stdout: '1 passing',
          timedOut: false,
        }
      },
    },
    '../preflight-runner': {
      runIsolationPreflight: async ({ isolationTestCandidate }) => {
        isolationPreflights++
        selectedIsolationSource = isolationTestCandidate.sourceFile
        return {
          ok: isolationPreflightOk,
          preflight: {
            ran: true,
            exitCode: isolationPreflightOk ? 0 : 1,
            maxTestCount: 1,
            observedTestCount: isolationPreflightOk ? 1 : 0,
          },
        }
      },
    },
    './helpers': {
      basicEventEvidence: events => {
        const count = events.includes('complete') ? 1 : 0
        return {
          testSessionEvents: count,
          testModuleEvents: count,
          testSuiteEvents: count,
          testEvents: count,
        }
      },
      failWithDebugRerun: async options => {
        debugReruns++
        options.evidence.debugRerun = {
          ran: true,
          debugLines: ['Test Optimization debug fixture output.'],
        }
        return {
          artifacts: [],
          diagnosis: options.diagnosis,
          evidence: options.evidence,
          frameworkId: options.framework.id,
          scenario: options.scenarioName,
          status: 'fail',
        }
      },
      hasAllBasicEventTypes: events => events.includes('complete'),
      runInstrumentedCommand: async ({ out, scenarioName }) => {
        const events = scenarioName === 'basic-reporting-isolation' && isolationHasEvents
          ? ['complete']
          : []
        const isolation = scenarioName === 'basic-reporting-isolation'
        return {
          events,
          offline: {
            initialized: isolation ? isolationExporterInitialized : primaryExporterInitialized,
            inputs: {
              settings: {
                status: (isolation ? isolationSettingsLoaded : primarySettingsLoaded) ? 'loaded' : 'missing',
              },
            },
            summary: { errors: [] },
          },
          outDir: path.join(out, scenarioName),
          result: {
            exitCode: isolation ? isolationExitCode : primaryExitCode,
            stderr: '',
            stdout: '1 passing',
            timedOut: isolation ? false : primaryTimedOut,
          },
        }
      },
    },
  })
  return {
    ...basicReporting,
    getExecutionCounts: () => ({ cleanConfirmations, debugReruns, isolationPreflights, selectedIsolationSource }),
  }
}
