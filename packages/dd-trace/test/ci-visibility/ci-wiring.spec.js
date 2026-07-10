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
