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
  it('validates reporting, CI wiring, EFD, ATR, and Test Management with all socket operations blocked', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-offline-scenarios-'))
    const existingTest = path.join(out, 'existing.spec.js')
    const generatedTest = path.join(out, 'dd-test-optimization-validation.spec.js')
    const retryState = path.join(out, '.dd-test-optimization-validation-atr-state')
    const networkBlocker = path.join(out, 'block-network.js')
    const mocha = path.resolve('node_modules/.bin/mocha')
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
      argv: [mocha, '--reporter', 'spec', file],
      env: { NODE_OPTIONS: `-r ${networkBlocker}` },
      timeoutMs: 10_000,
      usesShell: false,
    })
    const scenarioCommand = name => ({
      ...command(generatedTest),
      argv: [
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
        provider: 'test',
        diagnosis: 'The test CI command includes the Datadog preload.',
      },
      ciWiringCommand: {
        ...command(existingTest),
        env: { NODE_OPTIONS: `-r ${networkBlocker} -r ${init}` },
      },
      preflight: { ran: true, exitCode: 0, observedTestCount: 1 },
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

      assert.deepStrictEqual({
        basic: basic.status,
        ciWiring: ciWiring.status,
        efd: efd.status,
        atr: atr.status,
        testManagement: testManagement.status,
      }, {
        basic: 'pass',
        ciWiring: 'pass',
        efd: 'pass',
        atr: 'pass',
        testManagement: 'pass',
      })
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
        argv: [path.resolve('node_modules/.bin/mocha'), testFile],
        timeoutMs: 10_000,
      }
      const workerCommand = {
        ...command,
        argv: [path.resolve('node_modules/.bin/mocha'), '--parallel', '--jobs', '2', testFile],
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

      const events = fs.readFileSync(path.join(out, 'runs', 'mocha-root', 'basic-reporting', 'events.ndjson'), 'utf8')
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
