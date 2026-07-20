'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  runInitializationProbe,
} = require('../../../../ci/test-optimization-validation/init-probe')
const {
  cleanupGeneratedFiles,
} = require('../../../../ci/test-optimization-validation/generated-files')
const {
  runAutoTestRetries,
} = require('../../../../ci/test-optimization-validation/scenarios/auto-test-retries')
const {
  runBasicReporting,
} = require('../../../../ci/test-optimization-validation/scenarios/basic-reporting')
const {
  runCiWiring,
} = require('../../../../ci/test-optimization-validation/scenarios/ci-wiring')
const {
  runEarlyFlakeDetection,
} = require('../../../../ci/test-optimization-validation/scenarios/early-flake-detection')
const {
  runInstrumentedCommand,
} = require('../../../../ci/test-optimization-validation/scenarios/helpers')
const {
  runTestManagement,
} = require('../../../../ci/test-optimization-validation/scenarios/test-management')

const PROBE_FILE_ENV = 'DD_TEST_OPTIMIZATION_INIT_PROBE_FILE'
const PROBE_PRELOAD = path.resolve(__dirname, '../../../../ci/test-optimization-validation/init-probe-preload.js')

function validationOptions (repositoryRoot) {
  return {
    approvedPlanSha256: '0'.repeat(64),
    offlineFixtureNonce: '0'.repeat(32),
    repositoryRoot,
    verbose: false,
  }
}

describe('test optimization validation scenario artifacts', () => {
  it('diagnoses missing offline initialization while preserving command artifacts', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-initialization-failure-'))
    const testRunner = path.join(out, 'test-runner.js')
    const wrapper = path.join(out, process.platform === 'win32' ? 'run-tests.cmd' : 'run-tests.sh')
    fs.writeFileSync(testRunner, "console.log('1 passing')\n")
    fs.writeFileSync(wrapper, process.platform === 'win32'
      ? `@echo off\r\nset "NODE_OPTIONS="\r\n"${process.execPath}" "${testRunner}"\r\n`
      : `#!/bin/sh\nunset NODE_OPTIONS\nexec "${process.execPath}" "${testRunner}"\n`)
    const command = process.platform === 'win32'
      ? [process.env.ComSpec, '/d', '/s', '/c', wrapper]
      : ['/bin/sh', wrapper]
    const framework = {
      id: 'mocha:initialization-failure',
      framework: 'mocha',
      existingTestCommand: {
        cwd: out,
        argv: command,
        timeoutMs: 10_000,
      },
    }

    try {
      const result = await runBasicReporting({ framework, out, options: validationOptions(out) })

      assert.strictEqual(result.status, 'fail')
      assert.strictEqual(result.evidence.offlineExporterInitialized, false)
      assert.strictEqual(result.evidence.debugRerun.offlineExporterInitialized, false)
      assert.strictEqual(result.evidence.localDiagnosis.kind, 'tests-ran-no-test-optimization-events')
      assert.match(result.diagnosis, /selected command ran tests, but no Test Optimization events reached/)
      assert.strictEqual(result.artifacts.length, 10)
      const outDir = path.dirname(result.artifacts[0])
      assert.deepStrictEqual(result.artifacts, [
        path.join(outDir, 'command.json'),
        path.join(outDir, 'stdout.txt'),
        path.join(outDir, 'stderr.txt'),
        path.join(outDir, 'events.ndjson'),
        path.join(outDir, 'result.json'),
        path.join(`${outDir}-debug`, 'command.json'),
        path.join(`${outDir}-debug`, 'stdout.txt'),
        path.join(`${outDir}-debug`, 'stderr.txt'),
        path.join(`${outDir}-debug`, 'events.ndjson'),
        path.join(`${outDir}-debug`, 'result.json'),
      ])
      assert.ok(result.artifacts.every(filename => fs.existsSync(filename)))
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('validates reporting, CI wiring, EFD, ATR, and Test Management with all socket operations blocked', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-offline-scenarios-'))
    const existingTest = path.join(out, 'existing.spec.js')
    const generatedTest = path.join(out, 'dd-test-optimization-validation.spec.js')
    const retryState = path.join(out, '.dd-test-optimization-validation-atr-state')
    const networkBlocker = path.join(out, 'block-network.js')
    const mocha = path.resolve('node_modules/mocha/bin/mocha.js')
    const init = path.resolve('ci/init.js')

    fs.writeFileSync(existingTest, "describe('existing suite', () => { it('works', () => {}) })\n")
    fs.writeFileSync(networkBlocker, [
      "const fail = () => { throw new Error('validation attempted a network operation') }",
      "for (const name of ['node:http', 'node:https']) {",
      '  const client = require(name)',
      '  client.get = fail',
      '  client.request = fail',
      '}',
      "const net = require('node:net')",
      'net.connect = fail',
      'net.createConnection = fail',
      'net.createServer = fail',
      "require('node:tls').connect = fail",
      "require('node:dgram').createSocket = fail",
    ].join('\n'))

    const command = file => ({
      cwd: out,
      argv: [process.execPath, mocha, '--reporter', 'spec', file],
      env: { NODE_OPTIONS: `-r ${networkBlocker}` },
      timeoutMs: 10_000,
      usesShell: false,
    })
    const scenarioCommand = name => ({
      ...command(generatedTest),
      argv: [
        process.execPath,
        mocha,
        '--reporter',
        'spec',
        '--grep',
        `^dd-test-optimization-validation ${name}$`,
        generatedTest,
      ],
    })
    const framework = {
      id: 'mocha:offline-scenarios',
      framework: 'mocha',
      project: { root: out },
      existingTestCommand: command(existingTest),
      ciWiring: {
        status: 'unknown',
        replayability: 'replayable',
        provider: 'test',
        diagnosis: 'The test CI command includes the Datadog preload.',
      },
      ciWiringCommand: {
        ...command(existingTest),
        env: { NODE_OPTIONS: `-r ${networkBlocker} -r ${init}` },
      },
      preflight: { ran: true, exitCode: 0, observedTestCount: 1, maxTestCount: 1 },
      generatedTestStrategy: {
        status: 'verified',
        files: [{
          path: generatedTest,
          contentLines: [
            "const fs = require('node:fs')",
            `const retryState = ${JSON.stringify(retryState)}`,
            "describe('dd-test-optimization-validation', () => {",
            "  it('basic-pass', () => {})",
            "  it('atr-fail-once', () => {",
            '    if (!fs.existsSync(retryState)) {',
            "      fs.writeFileSync(retryState, 'failed-once')",
            "      throw new Error('expected first failure')",
            '    }',
            '  })',
            "  it('test-management-target', () => {})",
            '})',
          ],
        }],
        scenarios: [
          generatedScenario('basic-pass', generatedTest, scenarioCommand('basic-pass')),
          generatedScenario('atr-fail-once', generatedTest, scenarioCommand('atr-fail-once')),
          generatedScenario('test-management-target', generatedTest, scenarioCommand('test-management-target')),
        ],
        cleanupPaths: [generatedTest, retryState],
      },
      notes: [],
    }
    const options = validationOptions(out)

    try {
      const basic = await runBasicReporting({ framework, out, options })
      const ciWiring = await runCiWiring({
        manifest: { repository: { root: out }, frameworks: [framework] },
        framework,
        out,
        options,
        basicResult: basic,
      })
      const efd = await runEarlyFlakeDetection({ framework, out, options })
      const atr = await runAutoTestRetries({ framework, out, options })
      const testManagement = await runTestManagement({ framework, out, options })

      const actual = {
        basic: basic.status,
        ciWiring: ciWiring.status,
        efd: efd.status,
        atr: atr.status,
        testManagement: testManagement.status,
      }
      const expected = {
        basic: 'pass',
        ciWiring: 'pass',
        efd: 'pass',
        atr: 'pass',
        testManagement: 'pass',
      }
      const diagnoses = { basic, ciWiring, efd, atr, testManagement }

      assert.deepStrictEqual(actual, expected, JSON.stringify(diagnoses, null, 2))
    } finally {
      cleanupGeneratedFiles({ frameworks: [framework] })
      assert.strictEqual(fs.existsSync(generatedTest), false)
      assert.strictEqual(fs.existsSync(retryState), false)
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('collects Mocha worker events without sockets and redacts their secret-like data', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-scenario-artifacts-'))
    const testFile = path.join(out, 'validation.spec.js')
    const networkBlocker = path.join(out, 'block-network.js')
    fs.writeFileSync(testFile, [
      "describe('SECRET=direct-event-secret', () => {",
      "  const execution = process.env.MOCHA_WORKER_ID === undefined ? 'main' : 'worker'",
      "  it('API_KEY=direct-event-api-key-secret ' + execution, () => {})",
      '})',
    ].join('\n'))
    fs.writeFileSync(networkBlocker, [
      "const fail = () => { throw new Error('validation attempted a network operation') }",
      "for (const name of ['node:http', 'node:https']) {",
      '  const client = require(name)',
      '  client.get = fail',
      '  client.request = fail',
      '}',
      "const net = require('node:net')",
      'net.connect = fail',
      'net.createConnection = fail',
      'net.createServer = fail',
      "require('node:tls').connect = fail",
      "require('node:dgram').createSocket = fail",
    ].join('\n'))

    try {
      const command = {
        cwd: out,
        argv: [process.execPath, path.resolve('node_modules/mocha/bin/mocha.js'), testFile],
        timeoutMs: 10_000,
      }
      const workerCommand = {
        ...command,
        argv: [
          process.execPath,
          path.resolve('node_modules/mocha/bin/mocha.js'),
          '--parallel',
          '--jobs',
          '2',
          testFile,
        ],
      }
      const ciWiring = await runInstrumentedCommand({
        framework: {
          id: 'mocha:root',
          framework: 'mocha',
        },
        out,
        scenarioName: 'ci-wiring',
        command: {
          ...command,
          env: {
            NODE_OPTIONS: `-r ${networkBlocker} -r ${path.resolve('ci/init.js')}`,
          },
        },
        options: validationOptions(out),
        ciWiring: true,
      })
      const direct = await runInstrumentedCommand({
        framework: {
          id: 'mocha:root',
          framework: 'mocha',
        },
        out,
        scenarioName: 'basic-reporting',
        command: workerCommand,
        options: validationOptions(out),
        extraEnv: {
          NODE_OPTIONS: `-r ${networkBlocker} -r ${path.resolve('ci/init.js')}`,
        },
      })

      assert(direct.events.some(event => event.type === 'test' && event.testName.endsWith('worker')))
      assert(
        ciWiring.events.some(event => event.type === 'test'),
        `CI wiring output did not contain a test event: ${JSON.stringify({
          events: ciWiring.events,
          result: ciWiring.result,
        })}`
      )

      const events = fs.readFileSync(path.join(direct.outDir, 'events.ndjson'), 'utf8')
      assert.match(events, /<redacted>/)
      for (const secret of [
        'direct-event-api-key-secret',
        'direct-event-secret',
      ]) {
        assert.doesNotMatch(events, new RegExp(secret))
      }
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('validates aggregate output from independent exporter processes', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-multi-process-'))
    const eventExporter = path.join(out, 'event-exporter.js')
    const runner = path.join(out, 'runner.js')
    writeEventExporter(eventExporter)
    writeExporterRunner(runner)

    try {
      const run = await runInstrumentedCommand({
        framework: { id: 'node:multi-process', framework: 'node' },
        out,
        scenarioName: 'multi-process',
        command: {
          cwd: out,
          argv: [process.execPath, runner, eventExporter, eventExporter],
          timeoutMs: 10_000,
        },
        options: validationOptions(out),
        ciWiring: true,
      })

      assert.strictEqual(run.events.length, 2)
      assert.deepStrictEqual(run.offline.summary, {
        errors: [],
        eventsObserved: 2,
        eventsRetained: 2,
        inputs: {},
        payloadFiles: 2,
      })
      assert.strictEqual(run.offline.payloadFileCount, 2)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('completes a large multi-process CI replay with bounded early and late evidence', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-large-multi-process-'))
    const firstExporter = path.join(out, 'first-exporter.js')
    const secondExporter = path.join(out, 'second-exporter.js')
    const runner = path.join(out, 'runner.js')
    writeEventExporter(firstExporter, { eventCount: 2_100, includeLifecycle: true, namePrefix: 'first' })
    writeEventExporter(secondExporter, { eventCount: 2_100, includeLifecycle: true, namePrefix: 'second' })
    writeExporterRunner(runner)

    try {
      const run = await runInstrumentedCommand({
        framework: { id: 'node:large-multi-process', framework: 'node' },
        out,
        scenarioName: 'ci-wiring',
        command: {
          cwd: out,
          argv: [process.execPath, runner, firstExporter, secondExporter],
          timeoutMs: 10_000,
        },
        options: validationOptions(out),
        ciWiring: true,
      })

      assert.strictEqual(run.result.exitCode, 0)
      assert.strictEqual(run.offline.captureMode, 'sample')
      assert.strictEqual(run.offline.completionCount, 2)
      assert.strictEqual(run.offline.observedEventCount, 4_206)
      assert(run.offline.retainedEventCount <= 22)
      assert(run.offline.retainedEventCount < run.offline.observedEventCount)
      for (const type of ['test_suite_end', 'test_module_end', 'test_session_end']) {
        assert(run.events.some(event => event.type === type), `Missing retained ${type} evidence`)
      }
      assert(run.events.some(event => event.testName === 'first-0'))
      assert(run.events.some(event => event.testName === 'second-2099'))
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('fails closed when one independent exporter process reports an error', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-multi-process-error-'))
    const eventExporter = path.join(out, 'event-exporter.js')
    const failingExporter = path.join(out, 'failing-exporter.js')
    const runner = path.join(out, 'runner.js')
    writeEventExporter(eventExporter)
    writeFailingExporter(failingExporter)
    writeExporterRunner(runner)

    try {
      await assert.rejects(runInstrumentedCommand({
        framework: { id: 'node:multi-process-error', framework: 'node' },
        out,
        scenarioName: 'multi-process-error',
        command: {
          cwd: out,
          argv: [process.execPath, runner, eventExporter, failingExporter],
          timeoutMs: 10_000,
        },
        options: validationOptions(out),
        ciWiring: true,
      }), /Offline Test Optimization exporter failed: synthetic_exporter_failure/)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('redacts secret-like argv and execArgv values in initialization probe records', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-init-probe-'))
    const recordsPath = path.join(tmpDir, 'records.ndjson')

    fs.writeFileSync(recordsPath, '')

    try {
      execFileSync(process.execPath, [
        '-r',
        PROBE_PRELOAD,
        '-e',
        '"TOKEN=probe-exec-secret";',
        'API_KEY=probe-argv-secret',
      ], {
        cwd: tmpDir,
        env: {
          ...process.env,
          [PROBE_FILE_ENV]: recordsPath,
          NODE_OPTIONS: '',
        },
      })

      const records = fs.readFileSync(recordsPath, 'utf8')
      assert.match(records, /API_KEY=<redacted>/)
      assert.match(records, /TOKEN=<redacted>/)
      assert.doesNotMatch(records, /probe-argv-secret/)
      assert.doesNotMatch(records, /probe-exec-secret/)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('detects Playwright CLI paths in initialization probe records', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-init-probe-'))
    const recordsPath = path.join(tmpDir, 'records.ndjson')
    const playwrightCli = path.join(tmpDir, 'node_modules', 'playwright', 'cli.js')

    fs.mkdirSync(path.dirname(playwrightCli), { recursive: true })
    fs.writeFileSync(playwrightCli, 'process.exit(0)\n')
    fs.writeFileSync(recordsPath, '')

    try {
      execFileSync(process.execPath, [
        '-r',
        PROBE_PRELOAD,
        playwrightCli,
      ], {
        cwd: tmpDir,
        env: {
          ...process.env,
          [PROBE_FILE_ENV]: recordsPath,
          NODE_OPTIONS: '',
        },
      })

      const records = fs.readFileSync(recordsPath, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
      const processStart = records.find(record => record.type === 'process-start')

      assert.deepStrictEqual(processStart.detectedTools, [
        { name: 'playwright', kind: 'test-runner' },
      ])
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('rewrites child-controlled probe output as a bounded sanitized artifact', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-init-probe-parent-'))
    const script = [
      'const fs = require("node:fs")',
      'const file = process.env.DD_TEST_OPTIMIZATION_INIT_PROBE_FILE',
      'fs.appendFileSync(file, "TOKEN=raw-child-secret\\n")',
      'fs.appendFileSync(file, JSON.stringify({',
      '  type: "process-start", pid: 123, ppid: 1, cwd: process.cwd(),',
      '  argv: ["API_KEY=forged-child-secret"]',
      '}) + "\\n")',
    ].join(';')

    try {
      const probe = await runInitializationProbe({
        command: {
          cwd: out,
          argv: [process.execPath, '-e', script],
        },
        framework: { id: 'node:probe' },
        outDir: out,
        options: validationOptions(out),
      })
      const records = fs.readFileSync(probe.artifacts.records, 'utf8')

      assert.doesNotMatch(records, /raw-child-secret|forged-child-secret/)
      assert.doesNotMatch(records, /TOKEN=raw/)
      assert.match(records, /API_KEY=<redacted>/)
      assert.strictEqual(fs.existsSync(path.join(out, 'initialization-probe', '.records.raw.ndjson')), false)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('removes inline CI NODE_OPTIONS before adding the initialization probe preload', async function () {
    if (process.platform === 'win32') this.skip()

    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-init-probe-inline-'))
    const blocker = path.join(out, 'blocked-preload.js')
    fs.writeFileSync(blocker, "throw new Error('inline preload was not removed')\n")

    try {
      const probe = await runInitializationProbe({
        command: {
          cwd: out,
          argv: ['/usr/bin/env', `NODE_OPTIONS=-r ${blocker}`, process.execPath, '-e', ''],
        },
        framework: { id: 'vitest:probe', framework: 'vitest' },
        outDir: out,
        options: validationOptions(out),
      })

      assert.strictEqual(probe.summary.commandExitCode, 0)
      assert.strictEqual(probe.summary.reachedAnyNodeProcess, true)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('removes an exported shell NODE_OPTIONS before adding the initialization probe preload', async function () {
    if (process.platform === 'win32') this.skip()

    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-init-probe-shell-'))
    const blocker = path.join(out, 'blocked-preload.js')
    fs.writeFileSync(blocker, "throw new Error('inline preload was not removed')\n")

    try {
      const probe = await runInitializationProbe({
        command: {
          cwd: out,
          usesShell: true,
          shell: '/bin/sh',
          shellCommand: `export NODE_OPTIONS='-r ${blocker}'; ${JSON.stringify(process.execPath)} -e ''`,
        },
        framework: { id: 'vitest:probe', framework: 'vitest' },
        outDir: out,
        options: validationOptions(out),
      })

      assert.strictEqual(probe.summary.commandExitCode, 0)
      assert.strictEqual(probe.summary.reachedAnyNodeProcess, true)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })
})

function generatedScenario (id, file, runCommand) {
  return {
    id,
    runCommand,
    testIdentities: [{
      suite: 'dd-test-optimization-validation',
      name: id,
      file,
      parameters: null,
    }],
  }
}

function writeEventExporter (
  filename,
  { eventCount = 1, includeLifecycle = false, namePrefix = 'multi-process test' } = {}
) {
  const sinkPath = path.resolve('packages/dd-trace/src/ci-visibility/exporters/ci-validation/sink.js')
  const writerPath = path.resolve('packages/dd-trace/src/ci-visibility/exporters/ci-validation/writer.js')
  const idPath = path.resolve('packages/dd-trace/src/id.js')
  const lifecycleLines = includeLifecycle
    ? [
        "for (const type of ['test_suite_end', 'test_module_end', 'test_session_end']) spans.push({",
        "  trace_id: id('1234abcd1234abcd'),",
        "  span_id: id('1234abcd1234abcd'),",
        "  parent_id: id('0000000000000000'),",
        "  name: type, resource: type, service: 'validation', type, error: 0,",
        "  meta: { 'test.status': 'pass' }, metrics: {}, start: 123, duration: 456,",
        '})',
      ]
    : []
  fs.writeFileSync(filename, [
    `const { CiValidationSink } = require(${JSON.stringify(sinkPath)})`,
    `const CiValidationWriter = require(${JSON.stringify(writerPath)})`,
    `const id = require(${JSON.stringify(idPath)})`,
    'const sink = new CiValidationSink(process.env._DD_TEST_OPTIMIZATION_VALIDATION_OUTPUT_DIR, {',
    "  captureMode: process.env._DD_TEST_OPTIMIZATION_VALIDATION_CAPTURE_MODE || 'strict',",
    '})',
    'const writer = new CiValidationWriter({ sink, tags: {} })',
    'const spans = []',
    `for (let index = 0; index < ${eventCount}; index++) spans.push({`,
    "  trace_id: id('1234abcd1234abcd'),",
    "  span_id: id('1234abcd1234abcd'),",
    "  parent_id: id('0000000000000000'),",
    `  name: 'test', resource: ${JSON.stringify(namePrefix)} + '-' + index, service: 'validation',`,
    "  type: 'test', error: 0,",
    `  meta: { 'test.name': ${JSON.stringify(namePrefix)} + '-' + index, 'test.status': 'pass' },`,
    '  metrics: {}, start: 123, duration: 456,',
    '})',
    ...lifecycleLines,
    'writer.append(spans)',
    'writer.flush()',
    'sink.writeSummary()',
  ].join('\n'))
}

function writeFailingExporter (filename) {
  const sinkPath = path.resolve('packages/dd-trace/src/ci-visibility/exporters/ci-validation/sink.js')
  fs.writeFileSync(filename, [
    `const { CiValidationSink } = require(${JSON.stringify(sinkPath)})`,
    'const sink = new CiValidationSink(process.env._DD_TEST_OPTIMIZATION_VALIDATION_OUTPUT_DIR, {',
    "  captureMode: process.env._DD_TEST_OPTIMIZATION_VALIDATION_CAPTURE_MODE || 'strict',",
    '})',
    'sink.recordError("synthetic_exporter_failure")',
    'sink.writeSummary()',
  ].join('\n'))
}

function writeExporterRunner (filename) {
  fs.writeFileSync(filename, [
    "const { spawn } = require('node:child_process')",
    'const scripts = process.argv.slice(2)',
    'let remaining = scripts.length',
    'let failed = false',
    'for (const script of scripts) {',
    '  const child = spawn(process.execPath, [script], {',
    "    env: { ...process.env, NODE_OPTIONS: '' },",
    "    stdio: 'inherit',",
    '  })',
    '  child.on(\'error\', () => { failed = true })',
    '  child.on(\'exit\', code => {',
    '    if (code !== 0) failed = true',
    '    if (--remaining === 0) process.exitCode = failed ? 1 : 0',
    '  })',
    '}',
  ].join('\n'))
}
