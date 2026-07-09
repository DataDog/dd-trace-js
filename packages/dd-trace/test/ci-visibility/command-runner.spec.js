'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const proxyquire = require('proxyquire').noCallThru().noPreserveCache()

const {
  buildCiWiringEnv,
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

  it('does not inject --import for Vitest on Node versions that do not support it', () => {
    const { withCiPreloads } = proxyquire('../../../../ci/test-optimization-validation/command-runner', {
      '../../version': {
        NODE_MAJOR: 18,
        NODE_MINOR: 17,
      },
    })
    const nodeOptions = withCiPreloads('', { framework: 'vitest' })

    assert.doesNotMatch(nodeOptions, /--import/)
    assert.match(nodeOptions, /[\\/]ci[\\/]init\.js/)
  })

  it('injects --import for Vitest on Node versions that support it', () => {
    const { withCiPreloads } = proxyquire('../../../../ci/test-optimization-validation/command-runner', {
      '../../version': {
        NODE_MAJOR: 18,
        NODE_MINOR: 18,
      },
    })
    const nodeOptions = withCiPreloads('', { framework: 'vitest' })

    assert.match(nodeOptions, /--import/)
    assert.match(nodeOptions, /[\\/]register\.js/)
    assert.match(nodeOptions, /[\\/]ci[\\/]init\.js/)
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
    assert.strictEqual(env.DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE, 'false')
    assert.strictEqual(env.DD_TEST_FAILED_TEST_REPLAY_ENABLED, 'false')
    assert.strictEqual(env.DD_TRACE_ENABLED, 'true')
    assert.match(env.NODE_OPTIONS, /[\\/]ci[\\/]init\.js/)
  })

  it('disables unrelated Datadog side channels during CI wiring replay', () => {
    const env = buildCiWiringEnv({
      intake: { port: 1234 },
    })

    assert.strictEqual(env.DD_CIVISIBILITY_GIT_UPLOAD_ENABLED, 'false')
    assert.strictEqual(env.DD_CIVISIBILITY_GIT_UNSHALLOW_ENABLED, 'false')
    assert.strictEqual(env.DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED, 'false')
    assert.strictEqual(env.DD_INSTRUMENTATION_TELEMETRY_ENABLED, 'false')
    assert.strictEqual(env.DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE, 'false')
    assert.strictEqual(env.DD_TEST_FAILED_TEST_REPLAY_ENABLED, 'false')
    assert.strictEqual(env.DD_TRACE_DEBUG, '1')
    assert.strictEqual(env.DD_TRACE_LOG_LEVEL, 'debug')
    assert.strictEqual(env.DD_CIVISIBILITY_ENABLED, undefined)
    assert.strictEqual(env.NODE_OPTIONS, undefined)
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

  it('forces timed-out commands to terminate when SIGTERM is ignored', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-command-runner-'))

    try {
      const result = await runCommand({
        cwd: outDir,
        argv: [
          process.execPath,
          '-e',
          'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)',
        ],
        // Give the child process enough time to start and register its SIGTERM handler.
        timeoutMs: 500,
        timeoutKillGraceMs: 25,
        timeoutFinalizeGraceMs: 25,
      }, {
        outDir,
      })

      assert.strictEqual(result.timedOut, true)
      assert.strictEqual(result.exitCode, null)
      // Windows does not expose Unix-style SIGKILL escalation; SIGTERM terminates the process.
      assert.strictEqual(result.signal, process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL')
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true })
    }
  })

  it('terminates timed-out shell command process groups', async function () {
    if (process.platform === 'win32') this.skip()

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-command-runner-'))
    const marker = path.join(outDir, 'shell-child-survived')
    const childScript = [
      'process.on("SIGTERM", () => {})',
      `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"), 750)`,
      'setInterval(() => {}, 1000)',
    ].join(';')

    try {
      const result = await runCommand({
        cwd: outDir,
        usesShell: true,
        shellCommand: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(childScript)}`,
        timeoutMs: 500,
        timeoutKillGraceMs: 50,
        timeoutFinalizeGraceMs: 50,
      }, {
        outDir,
      })

      await new Promise(resolve => setTimeout(resolve, 600))

      assert.strictEqual(result.timedOut, true)
      assert.strictEqual(fs.existsSync(marker), false)
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true })
    }
  })

  it('terminates timed-out argv command process groups', async function () {
    if (process.platform === 'win32') this.skip()

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-command-runner-'))
    const marker = path.join(outDir, 'argv-child-survived')
    const childScript = [
      'process.on("SIGTERM", () => {})',
      `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"), 750)`,
      'setInterval(() => {}, 1000)',
    ].join(';')
    const parentScript = [
      'const { spawn } = require("node:child_process")',
      `spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(childScript)}], { stdio: "ignore" })`,
      'process.on("SIGTERM", () => process.exit(0))',
      'setInterval(() => {}, 1000)',
    ].join(';')

    try {
      const result = await runCommand({
        cwd: outDir,
        argv: [process.execPath, '-e', parentScript],
        timeoutMs: 500,
        timeoutKillGraceMs: 50,
        timeoutFinalizeGraceMs: 50,
      }, {
        outDir,
      })

      await new Promise(resolve => setTimeout(resolve, 600))

      assert.strictEqual(result.timedOut, true)
      assert.strictEqual(fs.existsSync(marker), false)
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true })
    }
  })

  it('uses an explicit shell for shell commands', async function () {
    if (process.platform === 'win32') this.skip()

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-command-runner-'))
    const marker = path.join(outDir, 'custom-shell-used')
    const shell = path.join(outDir, 'custom-shell')

    fs.writeFileSync(shell, [
      '#!/bin/sh',
      `echo yes > ${JSON.stringify(marker)}`,
      'exec /bin/sh "$@"',
      '',
    ].join('\n'))
    fs.chmodSync(shell, 0o755)

    try {
      const result = await runCommand({
        cwd: outDir,
        usesShell: true,
        shellCommand: 'echo ok',
        shell,
        timeoutMs: 1000,
      }, {
        outDir,
      })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(fs.readFileSync(marker, 'utf8').trim(), 'yes')
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true })
    }
  })

  it('redacts secret-like values from command artifacts', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-command-runner-'))

    try {
      await runCommand({
        cwd: outDir,
        usesShell: true,
        shellCommand: `${JSON.stringify(process.execPath)} ` +
          '-e "console.log(\'DD_API_KEY=stdout-secret\'); console.error(\'Authorization: Bearer stderr-secret\')" ' +
          '-- DD_API_KEY=command-secret --token command-token',
        displayCommand: 'DD_API_KEY=display-secret node --token display-token test',
        timeoutMs: 1000,
      }, {
        outDir,
      })

      const commandArtifact = fs.readFileSync(path.join(outDir, 'command.json'), 'utf8')
      assert.doesNotMatch(commandArtifact, /command-secret/)
      assert.doesNotMatch(commandArtifact, /command-token/)
      assert.doesNotMatch(commandArtifact, /display-secret/)
      assert.doesNotMatch(commandArtifact, /display-token/)
      assert.match(commandArtifact, /DD_API_KEY=<redacted>/)
      assert.match(commandArtifact, /--token <redacted>/)

      const stdoutArtifact = fs.readFileSync(path.join(outDir, 'stdout.txt'), 'utf8')
      const stderrArtifact = fs.readFileSync(path.join(outDir, 'stderr.txt'), 'utf8')
      assert.doesNotMatch(stdoutArtifact, /stdout-secret/)
      assert.doesNotMatch(stderrArtifact, /stderr-secret/)
      assert.match(stdoutArtifact, /DD_API_KEY=<redacted>/)
      assert.match(stderrArtifact, /Authorization: <redacted>/)
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
