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
      const leaked = ['NODE_OPTIONS', 'DD_CIVISIBILITY_ENABLED'].filter(name => process.env[name])
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
    process.env.DD_CIVISIBILITY_ENABLED = '1'

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
      assert.match(result.diagnosis, /test command used by the CI job ran tests/)
      assert.match(result.diagnosis, /Datadog environment configured for the CI job does not reach dd-trace/)
      assert.match(result.diagnosis, /Forced local Basic Reporting passed/)
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
      assert.match(result.diagnosis, /test command used by the CI job ran tests/)
      assert.match(result.diagnosis, /Forced local Basic Reporting passed/)
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
