'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { runCiWiring } = require('../../../../ci/test-optimization-validation/scenarios/ci-wiring')

describe('test optimization CI wiring validation', () => {
  it('does not turn a failed CI wiring classification into a skip when its command is missing', async () => {
    const result = await runCiWiring({
      manifest: {},
      framework: {
        id: 'vitest:root',
        ciWiring: {
          status: 'fail',
          diagnosis: 'CI does not configure Datadog initialization.',
        },
      },
    })

    assert.strictEqual(result.status, 'fail')
    assert.strictEqual(result.diagnosis, 'CI does not configure Datadog initialization.')
  })

  it('fails from conclusive static CI evidence when the unavailable command cannot be replayed', async () => {
    const result = await runCiWiring({
      manifest: {},
      framework: {
        id: 'vitest:date-fns',
        framework: 'vitest',
        project: { name: 'date-fns' },
        ciWiring: {
          status: 'skip',
          provider: 'github-actions',
          diagnosis: 'The CI command requires mise, which is unavailable locally.',
          initialization: {
            status: 'not_configured',
            evidence: ['The selected CI job does not set NODE_OPTIONS or Datadog environment variables.'],
          },
        },
      },
      basicResult: {
        status: 'pass',
        diagnosis: 'Basic Reporting passed.',
      },
    })

    assert.strictEqual(result.status, 'fail')
    assert.match(result.diagnosis, /does not initialize Datadog/)
    assert.match(result.diagnosis, /exact CI command could not be replayed locally/)
    assert.match(result.diagnosis, /requires mise/)
    assert.match(result.diagnosis, /does not change the current conclusion/)
    assert.match(result.diagnosis, /next normal CI test run will provide end-to-end verification/)
    assert.strictEqual(result.evidence.eventLevelFailure.kind, 'ci-wiring-static-missing-initialization')
    assert.deepStrictEqual(result.evidence.forcedLocalBasicReporting, {
      ran: true,
      status: 'pass',
      diagnosis: 'Basic Reporting passed.',
    })
    assert.deepStrictEqual(result.evidence.ciRemediation.variants.map(variant => variant.id), ['agentless'])
  })

  it('reports unknown CI wiring without a replay command as incomplete', async () => {
    const result = await runCiWiring({
      manifest: {},
      framework: {
        id: 'vitest:root',
        ciWiring: {
          status: 'unknown',
          reason: 'CI command selection was not completed.',
        },
      },
    })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.manifestIncomplete, true)
    assert.match(result.diagnosis, /manifest is incomplete/)
  })

  it('does not inherit ambient Datadog initialization from the validator process', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
    const originalNodeOptions = process.env.NODE_OPTIONS
    const originalCiVisibilityEnabled = process.env.DD_CIVISIBILITY_ENABLED
    const script = `
      const leaked = []
      if (String(process.env.NODE_OPTIONS || '').includes('dd-validation-ambient-ci-init')) {
        leaked.push('NODE_OPTIONS')
      }
      if (process.env.DD_CIVISIBILITY_ENABLED === 'ambient-ci-visibility-enabled') {
        leaked.push('DD_CIVISIBILITY_ENABLED')
      }
      if (leaked.length > 0) {
        process.stderr.write('leaked ' + leaked.join(','))
        process.exit(42)
      }
      console.log('1 passing')
    `
    const intake = {
      port: 8126,
      requests: [],
      configure () {},
      resetRequests () {
        this.requests = []
      },
    }

    process.env.NODE_OPTIONS = '--require /tmp/dd-validation-ambient-ci-init.js'
    process.env.DD_CIVISIBILITY_ENABLED = 'ambient-ci-visibility-enabled'

    try {
      const result = await runCiWiring({
        framework: {
          id: 'jest:root',
          framework: 'jest',
          ciWiringCommand: {
            cwd: out,
            argv: [process.execPath, '-e', script],
          },
          preflight: {
            ran: true,
            exitCode: 0,
            observedTestCount: 1,
          },
        },
        intake,
        out,
        options: { verbose: false },
        basicResult: {
          status: 'pass',
          diagnosis: 'Basic reporting emitted session, module, suite, and test events.',
        },
      })

      assert.strictEqual(result.status, 'fail')
      assert.strictEqual(result.evidence.commandExitCode, 0)
      assert.match(result.diagnosis, /test command used by the CI job was identified and ran tests/)
      assert.match(result.diagnosis, /environment and setup described by the CI job/)
      assert.match(result.diagnosis, /required Datadog initialization directly/)
      assert.deepStrictEqual(result.evidence.forcedLocalBasicReporting, {
        ran: true,
        status: 'pass',
        diagnosis: 'Basic reporting emitted session, module, suite, and test events.',
      })
    } finally {
      restoreEnv('NODE_OPTIONS', originalNodeOptions)
      restoreEnv('DD_CIVISIBILITY_ENABLED', originalCiVisibilityEnabled)
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('preserves the manifest CI diagnosis and recommends an existing Datadog test script', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
    const intake = {
      port: 8126,
      requests: [],
      configure () {},
      resetRequests () {
        this.requests = []
      },
    }
    fs.writeFileSync(path.join(out, 'package.json'), `${JSON.stringify({
      scripts: {
        test: 'jest',
        'test:datadog': "NODE_OPTIONS='-r dd-trace/ci/init' npm test",
      },
    })}\n`)

    try {
      const result = await runCiWiring({
        manifest: { repository: { root: out } },
        framework: {
          id: 'jest:root',
          framework: 'jest',
          project: { root: out },
          ciWiring: {
            diagnosis: 'The CI step runs test instead of the existing test:datadog script.',
          },
          ciWiringCommand: {
            cwd: out,
            argv: [process.execPath, '-e', 'console.log("1 passing")'],
          },
        },
        intake,
        out,
        options: { verbose: false },
        basicResult: {
          status: 'pass',
          diagnosis: 'Basic Reporting passed.',
        },
      })

      assert.strictEqual(result.status, 'fail')
      assert.match(result.diagnosis, /CI step runs test instead of the existing test:datadog script/)
      assert.deepStrictEqual(result.evidence.existingDatadogInitScripts, [{
        name: 'test:datadog',
        packageJson: path.join(out, 'package.json'),
      }])
      assert.match(result.evidence.eventLevelFailure.recommendation, /already defines `test:datadog`/)
      assert.match(result.evidence.eventLevelFailure.recommendation, /identified CI test step to invoke that script/)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('diagnoses dd-trace initialization from a Vitest setup file as too late', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
    const setupFile = path.join(out, 'datadog-setup.ts')
    const configFile = path.join(out, 'vitest.config.ts')
    const intake = {
      port: 8126,
      requests: [],
      configure () {},
      resetRequests () {
        this.requests = []
      },
    }
    fs.writeFileSync(setupFile, 'import "dd-trace/ci/init"\n')
    fs.writeFileSync(configFile, 'export default { test: { setupFiles: ["datadog-setup.ts"] } }\n')

    try {
      const result = await runCiWiring({
        manifest: { repository: { root: out } },
        framework: {
          id: 'vitest:root',
          framework: 'vitest',
          project: { root: out, configFiles: [configFile] },
          ciWiringCommand: {
            cwd: out,
            argv: [process.execPath, '-e', 'console.log("Tests 1 passed")'],
          },
        },
        intake,
        out,
        options: { verbose: false },
        basicResult: { status: 'pass', diagnosis: 'Basic Reporting passed.' },
      })

      assert.strictEqual(result.status, 'fail')
      assert.deepStrictEqual(result.evidence.lateInitialization, [{ configFile, setupFile }])
      assert.match(result.diagnosis, /setup files after the runner starts.*too late/s)
      assert.match(result.evidence.eventLevelFailure.recommendation, /Move Test Optimization initialization out/)
      assert.match(result.evidence.eventLevelFailure.recommendation, /NODE_OPTIONS=-r dd-trace\/ci\/init/)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('diagnoses a package script that explicitly removes NODE_OPTIONS', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
    const intake = {
      port: 8126,
      requests: [],
      configure () {},
      resetRequests () {
        this.requests = []
      },
    }

    try {
      const packageJson = path.join(out, 'package.json')
      fs.writeFileSync(packageJson, `${JSON.stringify({
        scripts: {
          'test:ci': 'NODE_OPTIONS= yarn workspace app test',
        },
      }, null, 2)}\n`)
      const result = await runCiWiring({
        manifest: { repository: { root: out } },
        framework: {
          id: 'vitest:root',
          framework: 'vitest',
          ciWiring: {
            packageScriptExpansionChain: [
              'yarn test:ci',
              'NODE_OPTIONS= yarn workspace app test',
              'vitest run',
            ],
          },
          ciWiringCommand: {
            cwd: out,
            argv: [process.execPath, '-e', 'console.log("Tests 1 passed")'],
          },
        },
        intake,
        out,
        options: { verbose: false },
        basicResult: { status: 'pass', diagnosis: 'Basic Reporting passed.' },
      })

      assert.strictEqual(result.status, 'fail')
      assert.deepStrictEqual(result.evidence.nodeOptionsRemoval, {
        command: 'NODE_OPTIONS= yarn workspace app test',
        packageJson,
        scriptName: 'test:ci',
      })
      assert.match(result.diagnosis, /script `test:ci` in .*package\.json.*empty `NODE_OPTIONS=` assignment/s)
      assert.match(result.diagnosis, /same Vitest test command.*reports test data successfully/s)
      assert.match(result.evidence.eventLevelFailure.recommendation,
        /Script `test:ci` in .*package\.json.*clears NODE_OPTIONS/s)
      assert.match(result.evidence.eventLevelFailure.recommendation, /pass the CI-provided/)
      assert.doesNotMatch(result.evidence.eventLevelFailure.recommendation, /Compare the passing/)
      assert.deepStrictEqual(result.evidence.monorepoFindings, [])
      assert.strictEqual(result.evidence.initializationProbe.ran, false)
      assert.strictEqual(result.evidence.initializationProbe.skippedBecauseConfigurationProvesRemoval, true)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('replays shell CI commands with the recorded CI shell', async function () {
    if (process.platform === 'win32') this.skip()

    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
    const marker = path.join(out, 'ci-shell-used')
    const shell = path.join(out, 'ci-shell')
    const intake = {
      port: 8126,
      requests: [],
      configure () {},
      resetRequests () {
        this.requests = []
      },
    }

    fs.writeFileSync(shell, [
      '#!/bin/sh',
      `echo yes > ${JSON.stringify(marker)}`,
      'exec /bin/sh "$@"',
      '',
    ].join('\n'))
    fs.chmodSync(shell, 0o755)

    try {
      const result = await runCiWiring({
        framework: {
          id: 'jest:root',
          framework: 'jest',
          ciWiring: {
            shell,
          },
          ciWiringCommand: {
            cwd: out,
            usesShell: true,
            shellCommand: 'echo "1 passing"',
          },
        },
        intake,
        out,
        options: { verbose: false },
      })

      assert.strictEqual(result.evidence.commandExitCode, 0)
      assert.strictEqual(fs.readFileSync(marker, 'utf8').trim(), 'yes')
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('preserves recorded CI shell failure flags when replaying shell templates', async function () {
    if (process.platform === 'win32') this.skip()

    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
    const intake = {
      port: 8126,
      requests: [],
      configure () {},
      resetRequests () {
        this.requests = []
      },
    }

    try {
      const result = await runCiWiring({
        framework: {
          id: 'jest:root',
          framework: 'jest',
          ciWiring: {
            shell: 'bash --noprofile --norc -eo pipefail {0}',
          },
          ciWiringCommand: {
            cwd: out,
            usesShell: true,
            shellCommand: 'false | true',
          },
        },
        intake,
        out,
        options: { verbose: false },
      })

      assert.strictEqual(result.status, 'fail')
      assert.strictEqual(result.evidence.commandExitCode, 1)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('preserves recorded CI shell failure flags without template placeholders', async function () {
    if (process.platform === 'win32') this.skip()

    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
    const intake = {
      port: 8126,
      requests: [],
      configure () {},
      resetRequests () {
        this.requests = []
      },
    }

    try {
      const result = await runCiWiring({
        framework: {
          id: 'jest:root',
          framework: 'jest',
          ciWiring: {
            shell: 'bash --noprofile --norc -eo pipefail',
          },
          ciWiringCommand: {
            cwd: out,
            usesShell: true,
            shellCommand: 'false | true',
          },
        },
        intake,
        out,
        options: { verbose: false },
      })

      assert.strictEqual(result.status, 'fail')
      assert.strictEqual(result.evidence.commandExitCode, 1)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('redacts secret-like event data in CI wiring events artifacts', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
    const intake = {
      port: 8126,
      requests: [
        testIntakeRequest({
          API_KEY: 'ci-wiring-event-api-key-secret',
          command: 'TOKEN=ci-wiring-event-token-secret npm test',
          message: 'SECRET=ci-wiring-event-secret',
        }),
      ],
      configure () {},
      resetRequests () {},
    }

    try {
      await runCiWiring({
        framework: {
          id: 'vitest:root',
          framework: 'vitest',
          ciWiringCommand: {
            cwd: out,
            argv: [process.execPath, '-e', 'console.log("no tests selected")'],
          },
        },
        intake,
        out,
        options: { verbose: false },
      })

      const events = fs.readFileSync(path.join(out, 'runs', 'vitest-root', 'ci-wiring', 'events.ndjson'), 'utf8')
      assert.match(events, /<redacted>/)
      for (const secret of [
        'ci-wiring-event-api-key-secret',
        'ci-wiring-event-token-secret',
        'ci-wiring-event-secret',
      ]) {
        assert.doesNotMatch(events, new RegExp(secret))
      }
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('records when NODE_OPTIONS reaches a wrapper but not the test runner', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
    const nxScript = path.join(out, 'nx.js')
    const jestScript = path.join(out, 'jest.js')
    const intake = {
      port: 8126,
      requests: [],
      configure () {},
      resetRequests () {
        this.requests = []
      },
    }

    fs.writeFileSync(jestScript, 'console.log("1 passing")\n')
    fs.writeFileSync(nxScript, `
      const { spawnSync } = require('node:child_process')
      const env = { ...process.env }
      delete env.NODE_OPTIONS
      const child = spawnSync(process.execPath, [${JSON.stringify(jestScript)}], {
        env,
        stdio: 'inherit'
      })
      process.exit(child.status)
    `)

    try {
      const result = await runCiWiring({
        framework: {
          id: 'jest:nx',
          framework: 'jest',
          ciWiring: {
            provider: 'github-actions',
            workflow: 'test',
            job: 'unit',
            step: 'Run tests',
            diagnosis: 'Nx target selected from CI workflow.',
            runnerToolChain: ['pnpm test', 'nx test', 'jest'],
          },
          ciWiringCommand: {
            cwd: out,
            argv: [process.execPath, nxScript],
          },
          preflight: {
            ran: true,
            exitCode: 0,
            observedTestCount: 1,
          },
        },
        intake,
        out,
        options: { verbose: false },
        basicResult: {
          status: 'pass',
          diagnosis: 'Basic reporting emitted session, module, suite, and test events.',
        },
      })

      assert.strictEqual(result.status, 'fail')
      assert.strictEqual(result.evidence.initializationProbe.reachedAnyNodeProcess, true)
      assert.strictEqual(result.evidence.initializationProbe.reachedTestRunnerProcess, false)
      assert.deepStrictEqual(result.evidence.initializationProbe.wrapperSignals.map(signal => signal.name), ['nx'])
      assert.match(result.diagnosis, /NODE_OPTIONS probe reached nx/)
      assert.match(result.diagnosis, /did not appear to reach a Jest process/)
      assert.strictEqual(result.evidence.monorepoFindings[0].id, 'nx-executor-env-forwarding')
      assert.strictEqual(result.evidence.monorepoFindings.at(-1).id, 'node-options-not-observed-in-test-runner')
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('aggregates repeated test runner probe signals by tool and working directory', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
    const wrapperScript = path.join(out, 'run-tests.js')
    const vitestScript = path.join(out, 'vitest.mjs')
    const intake = {
      port: 8126,
      requests: [],
      configure () {},
      resetRequests () {
        this.requests = []
      },
    }

    fs.writeFileSync(vitestScript, 'console.log("Tests 1 passed")\n')
    fs.writeFileSync(wrapperScript, `
      const { spawnSync } = require('node:child_process')
      for (let index = 0; index < 2; index++) {
        spawnSync(process.execPath, [${JSON.stringify(vitestScript)}], { stdio: 'inherit' })
      }
    `)

    try {
      const result = await runCiWiring({
        framework: {
          id: 'vitest:root',
          framework: 'vitest',
          ciWiringCommand: {
            cwd: out,
            argv: [process.execPath, wrapperScript],
          },
        },
        intake,
        out,
        options: { verbose: false },
        basicResult: { status: 'pass', diagnosis: 'Basic Reporting passed.' },
      })

      assert.strictEqual(result.status, 'fail')
      assert.strictEqual(result.evidence.initializationProbe.reachedTestRunnerProcess, true)
      assert.strictEqual(result.evidence.initializationProbe.testRunnerSignals.length, 1)
      assert.strictEqual(result.evidence.initializationProbe.testRunnerSignals[0].name, 'vitest')
      assert.strictEqual(result.evidence.initializationProbe.testRunnerSignals[0].cwd, fs.realpathSync(out))
      assert.strictEqual(result.evidence.initializationProbe.testRunnerSignals[0].processCount, 1)
      assert.strictEqual(result.evidence.initializationProbe.stoppedAfterRunnerReached, true)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('uses static missing-initialization evidence and the exact-command probe instead of a full CI ' +
    'replay', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
    const vitestScript = path.join(out, 'vitest.mjs')
    const fullReplayMarker = path.join(out, 'full-replay-ran')
    const intake = {
      port: 8126,
      requests: [],
      configure () {},
      resetRequests () {
        this.requests = []
      },
    }
    fs.writeFileSync(vitestScript, `
      import fs from 'node:fs'
      setTimeout(() => {
        fs.writeFileSync(${JSON.stringify(fullReplayMarker)}, 'ran')
        console.log('Tests 1 passed')
      }, 1000)
    `)

    try {
      const result = await runCiWiring({
        manifest: { repository: { root: out } },
        framework: {
          id: 'vitest:root',
          framework: 'vitest',
          project: { root: out },
          ciWiring: {
            status: 'unknown',
            provider: 'github-actions',
            configFile: path.join(out, '.github/workflows/test.yml'),
            workflow: 'test',
            job: 'unit',
            step: 'Run tests',
            initialization: {
              status: 'not_configured',
              evidence: ['The unit job defines no NODE_OPTIONS or Datadog environment variables.'],
            },
          },
          ciWiringCommand: {
            cwd: out,
            argv: [process.execPath, vitestScript],
          },
        },
        intake,
        out,
        options: { repositoryRoot: out, verbose: false },
        basicResult: { status: 'pass', diagnosis: 'Basic Reporting passed.' },
      })

      assert.strictEqual(result.status, 'fail')
      assert.ok(result.evidence.ciCommandExecution, JSON.stringify(result.evidence, null, 2))
      assert.strictEqual(result.evidence.ciCommandExecution.fullReplayRan, false)
      assert.strictEqual(result.evidence.initializationProbe.reachedTestRunnerProcess, true)
      assert.strictEqual(fs.existsSync(fullReplayMarker), false)
      assert.match(result.diagnosis, /did not replay the full CI test suite/)
      assert.match(result.evidence.ciRemediation.variants[0].snippet, /NODE_OPTIONS/)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('treats monorepo runner success summaries as evidence that tests ran', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
    const intake = {
      port: 8126,
      requests: [],
      configure () {},
      resetRequests () {
        this.requests = []
      },
    }

    try {
      const result = await runCiWiring({
        framework: {
          id: 'vitest:lage',
          framework: 'vitest',
          ciWiringCommand: {
            cwd: out,
            argv: [process.execPath, '-e', 'console.log("success: 2, skipped: 0, pending: 0, failed: 0")'],
          },
        },
        intake,
        out,
        options: { verbose: false },
        basicResult: {
          status: 'pass',
          diagnosis: 'Basic reporting emitted session, module, suite, and test events.',
        },
      })

      assert.strictEqual(result.status, 'fail')
      assert.match(result.diagnosis, /test command used by the CI job was identified and ran tests/)
      assert.match(result.diagnosis, /required Datadog initialization directly/)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('treats monorepo runner failure summaries as evidence that tests ran', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
    const intake = {
      port: 8126,
      requests: [],
      configure () {},
      resetRequests () {
        this.requests = []
      },
    }

    try {
      const result = await runCiWiring({
        framework: {
          id: 'vitest:lage',
          framework: 'vitest',
          ciWiringCommand: {
            cwd: out,
            argv: [
              process.execPath,
              '-e',
              'console.log("success: 0, skipped: 0, pending: 0, failed: 2"); process.exit(1)',
            ],
          },
        },
        intake,
        out,
        options: { verbose: false },
        basicResult: {
          status: 'pass',
          diagnosis: 'Basic reporting emitted session, module, suite, and test events.',
        },
      })

      assert.strictEqual(result.status, 'fail')
      assert.strictEqual(result.evidence.commandExitCode, 1)
      assert.strictEqual(result.evidence.eventLevelFailure.kind, 'ci-wiring-no-test-optimization-events')
      assert.match(result.diagnosis, /test command used by the CI job was identified and ran tests/)
      assert.doesNotMatch(result.diagnosis, /failed before tests/)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('probes CI wiring when test output shows failing tests', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
    const intake = {
      port: 8126,
      requests: [],
      configure () {},
      resetRequests () {
        this.requests = []
      },
    }

    try {
      const result = await runCiWiring({
        framework: {
          id: 'vitest:root',
          framework: 'vitest',
          ciWiringCommand: {
            cwd: out,
            argv: [process.execPath, '-e', 'console.log("Tests  1 failed | 2 passed (3)"); process.exit(1)'],
          },
        },
        intake,
        out,
        options: { verbose: false },
        basicResult: {
          status: 'pass',
          diagnosis: 'Basic reporting emitted session, module, suite, and test events.',
        },
      })

      assert.strictEqual(result.status, 'fail')
      assert.strictEqual(result.evidence.commandExitCode, 1)
      assert.match(result.diagnosis, /test command used by the CI job was identified and ran tests/)
      assert.match(result.diagnosis, /required Datadog initialization directly/)
      assert.strictEqual(result.evidence.initializationProbe.ran, true)
      assert.strictEqual(result.evidence.initializationProbe.reachedAnyNodeProcess, true)
      assert.strictEqual(result.evidence.initializationProbe.reachedTestRunnerProcess, false)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('does not match CI wiring exit codes against unrelated existing-command preflight', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
    const intake = {
      port: 8126,
      requests: [
        allBasicEventsRequest(),
      ],
      configure () {},
      resetRequests () {},
    }

    try {
      const result = await runCiWiring({
        framework: {
          id: 'jest:root',
          framework: 'jest',
          existingTestCommand: {
            cwd: out,
            argv: [process.execPath, '-e', 'console.log("different command"); process.exit(7)'],
          },
          ciWiringCommand: {
            cwd: out,
            argv: [process.execPath, '-e', 'process.exit(7)'],
          },
          preflight: {
            ran: true,
            exitCode: 7,
            observedTestCount: 1,
          },
        },
        intake,
        out,
        options: { verbose: false },
        basicResult: {
          status: 'pass',
          diagnosis: 'Basic reporting emitted session, module, suite, and test events.',
        },
      })

      assert.strictEqual(result.status, 'fail')
      assert.strictEqual(result.evidence.commandExitMatchesPreflight, false)
      assert.deepStrictEqual(result.evidence.preflight, {
        ran: false,
        reason: 'No dd-trace-less preflight result was recorded for the selected CI wiring command shape.',
      })
      assert.match(result.diagnosis, /emitted Test Optimization events, but the command exited 7/)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('does not report preload resolution failure when output proves tests ran', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
    const intake = {
      port: 8126,
      requests: [],
      configure () {},
      resetRequests () {
        this.requests = []
      },
    }

    try {
      const result = await runCiWiring({
        framework: {
          id: 'vitest:root',
          framework: 'vitest',
          ciWiringCommand: {
            cwd: out,
            argv: [
              process.execPath,
              '-e',
              'console.log("Tests  1 failed | 2 passed (3)"); ' +
                'console.error("Cannot find module dd-trace/ci/init"); process.exit(1)',
            ],
          },
        },
        intake,
        out,
        options: { verbose: false },
        basicResult: {
          status: 'pass',
          diagnosis: 'Basic reporting emitted session, module, suite, and test events.',
        },
      })

      assert.strictEqual(result.status, 'fail')
      assert.strictEqual(result.evidence.commandFailure, undefined)
      assert.strictEqual(result.evidence.eventLevelFailure.kind, 'ci-wiring-no-test-optimization-events')
      assert.match(result.diagnosis, /test command used by the CI job was identified and ran tests/)
      assert.doesNotMatch(result.diagnosis, /failed before tests started/)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('classifies dd-trace preload resolution failures before test execution', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
    const intake = {
      port: 8126,
      requests: [],
      configure () {},
      resetRequests () {
        this.requests = []
      },
    }

    try {
      const result = await runCiWiring({
        framework: {
          id: 'mocha:fixture',
          framework: 'mocha',
          ciWiringCommand: {
            cwd: out,
            argv: [process.execPath, '-e', 'console.log("this should not run")'],
            env: {
              NODE_OPTIONS: '-r dd-trace/ci/init',
            },
          },
        },
        intake,
        out,
        options: { verbose: false },
        basicResult: {
          status: 'pass',
          diagnosis: 'Basic reporting emitted session, module, suite, and test events.',
        },
      })

      assert.strictEqual(result.status, 'fail')
      assert.strictEqual(result.evidence.commandExitCode, 1)
      assert.strictEqual(result.evidence.commandFailure.kind, 'ci-wiring-preload-resolution-failed')
      assert.strictEqual(result.evidence.eventLevelFailure.kind, 'ci-wiring-preload-resolution-failed')
      assert.match(result.diagnosis, /failed before tests started/)
      assert.match(result.diagnosis, /could not resolve.*dd-trace\/ci\/init/)
      assert.doesNotMatch(result.diagnosis, /selected command may not have executed tests/)
      assert.strictEqual(result.evidence.initializationProbe, undefined)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('classifies CI-shaped command failures before observed test output', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
    const intake = {
      port: 8126,
      requests: [],
      configure () {},
      resetRequests () {
        this.requests = []
      },
    }

    try {
      const result = await runCiWiring({
        framework: {
          id: 'vitest:root',
          framework: 'vitest',
          ciWiringCommand: {
            cwd: out,
            argv: [process.execPath, '-e', 'console.error("No test files found"); process.exit(3)'],
          },
        },
        intake,
        out,
        options: { verbose: false },
      })

      assert.strictEqual(result.status, 'fail')
      assert.strictEqual(result.evidence.commandExitCode, 3)
      assert.strictEqual(result.evidence.commandFailure.kind, 'ci-wiring-command-failed-before-tests')
      assert.strictEqual(result.evidence.eventLevelFailure.kind, 'ci-wiring-command-failed-before-tests')
      assert.match(result.diagnosis, /exited 3 before the validator observed any tests running/)
      assert.match(result.diagnosis, /No CI wiring conclusion/)
      assert.doesNotMatch(result.diagnosis, /process may not have connected to the local intake/)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('does not classify unrelated preload failures as dd-trace preload failures', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
    const intake = {
      port: 8126,
      requests: [],
      configure () {},
      resetRequests () {
        this.requests = []
      },
    }

    try {
      const result = await runCiWiring({
        framework: {
          id: 'mocha:fixture',
          framework: 'mocha',
          ciWiringCommand: {
            cwd: out,
            argv: [process.execPath, '-e', 'console.log("this should not run")'],
            env: {
              NODE_OPTIONS: '-r ./missing-preload.js',
            },
          },
        },
        intake,
        out,
        options: { verbose: false },
      })

      assert.strictEqual(result.status, 'fail')
      assert.strictEqual(result.evidence.commandFailure.kind, 'ci-wiring-command-failed-before-tests')
      assert.notStrictEqual(result.evidence.eventLevelFailure.kind, 'ci-wiring-preload-resolution-failed')
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })
})

function restoreEnv (name, value) {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

function testIntakeRequest (meta) {
  return {
    method: 'POST',
    url: '/api/v2/citestcycle',
    payload: {
      events: [
        {
          type: 'test',
          content: {
            name: 'example test',
            meta: {
              'test.name': 'example test',
              'test.status': 'pass',
              ...meta,
            },
            metrics: {},
          },
        },
      ],
    },
  }
}

function allBasicEventsRequest () {
  return {
    method: 'POST',
    url: '/api/v2/citestcycle',
    payload: {
      events: [
        basicEvent('test_session_end'),
        basicEvent('test_module_end'),
        basicEvent('test_suite_end'),
        basicEvent('test'),
      ],
    },
  }
}

function basicEvent (type) {
  return {
    type,
    content: {
      name: 'example test',
      meta: {
        'test.name': 'example test',
        'test.status': 'pass',
      },
      metrics: {},
    },
  }
}
