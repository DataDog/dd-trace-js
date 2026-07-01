'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  buildDatadogEnv,
  getBaseEnv,
  getCommandDetails,
  mergeNodeOptions,
  runCommand,
  serializeDisplayCommand,
} = require('../../../../ci/test-optimization-validation/command-runner')

describe('test optimization validation command runner', () => {
  it('keeps project and validator NODE_OPTIONS together', () => {
    assert.strictEqual(
      mergeNodeOptions(
        '--import ./src/dev-loader.js',
        '--import dd-trace/register.js -r dd-trace/ci/init'
      ),
      '--import ./src/dev-loader.js --import dd-trace/register.js -r dd-trace/ci/init'
    )
  })

  it('disables unrelated Datadog side channels during forced local validation', () => {
    const env = buildDatadogEnv({
      intake: { port: 1234 },
      scenario: 'basic-reporting',
      framework: { framework: 'mocha' },
    })

    assert.strictEqual(env.DD_CIVISIBILITY_GIT_UPLOAD_ENABLED, 'false')
    assert.strictEqual(env.DD_CIVISIBILITY_GIT_UNSHALLOW_ENABLED, 'false')
    assert.strictEqual(env.DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED, 'false')
    assert.strictEqual(env.DD_INSTRUMENTATION_TELEMETRY_ENABLED, 'false')
    assert.strictEqual(env.DD_TEST_FAILED_TEST_REPLAY_ENABLED, 'false')
    assert.match(env.NODE_OPTIONS, /\/ci\/init\.js/)
  })

  it('collapses node and corepack runtime plumbing for display commands', () => {
    const command = {
      argv: [
        '/usr/bin/env',
        'PATH=/Users/example/.nvm/versions/node/v22.22.2/bin:/usr/bin',
        '/Users/example/.nvm/versions/node/v22.22.2/bin/node',
        '/Users/example/.nvm/versions/node/v22.22.2/lib/node_modules/corepack/dist/corepack.js',
        'pnpm',
        'vitest',
        'run',
        'packages/zod/src/index.test.ts',
      ],
    }

    assert.strictEqual(
      serializeDisplayCommand(command),
      'pnpm vitest run packages/zod/src/index.test.ts'
    )
    assert.deepStrictEqual(getCommandDetails(command), {
      exactCommandCollapsed: true,
      pathAdjusted: true,
      runtimeWrapper: 'node/corepack',
      packageManager: 'pnpm',
    })
  })

  it('returns a result for missing executable spawn failures', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-command-runner-'))

    try {
      const result = await runCommand({
        cwd: outDir,
        argv: ['definitely-missing-dd-validation-runner'],
        timeoutMs: 1000,
      }, {
        outDir,
      })

      assert.strictEqual(result.exitCode, null)
      assert.match(result.stderr, /ENOENT/)
      assert.ok(fs.existsSync(path.join(outDir, 'command.json')))
      assert.ok(fs.existsSync(path.join(outDir, 'stderr.txt')))
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true })
    }
  })

  it('keeps toolchain env but drops Datadog preloads from clean env', () => {
    const originalVoltaHome = process.env.VOLTA_HOME
    const originalNodeOptions = process.env.NODE_OPTIONS

    process.env.VOLTA_HOME = '/Users/example/.volta'
    process.env.NODE_OPTIONS = '-r dd-trace/ci/init'

    try {
      const cleanEnv = getBaseEnv('clean')

      assert.strictEqual(cleanEnv.VOLTA_HOME, '/Users/example/.volta')
      assert.strictEqual(cleanEnv.NODE_OPTIONS, undefined)
    } finally {
      if (originalVoltaHome === undefined) {
        delete process.env.VOLTA_HOME
      } else {
        process.env.VOLTA_HOME = originalVoltaHome
      }

      if (originalNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS
      } else {
        process.env.NODE_OPTIONS = originalNodeOptions
      }
    }
  })
})
