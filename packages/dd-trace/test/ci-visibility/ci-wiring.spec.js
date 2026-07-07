'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { runCiWiring } = require('../../../../ci/test-optimization-validation/scenarios/ci-wiring')

describe('test optimization CI wiring validation', () => {
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
