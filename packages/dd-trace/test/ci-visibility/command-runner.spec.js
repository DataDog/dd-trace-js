'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
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
  serializeApprovalCommand,
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

  it('does not execute an unapproved alternate Node binary to inspect its version', () => {
    const { withCiPreloads } = require('../../../../ci/test-optimization-validation/command-runner')
    const nodeOptions = withCiPreloads('', { framework: 'vitest' }, {
      cwd: process.cwd(),
      argv: ['/opt/node/18.17.1/bin/node', 'node_modules/.bin/vitest', 'run'],
    })

    assert.doesNotMatch(nodeOptions, /--import/)
    assert.match(nodeOptions, /[\\/]ci[\\/]init\.js/)
  })

  it('conservatively omits --import for any explicit alternate Node executable', () => {
    const { withCiPreloads } = require('../../../../ci/test-optimization-validation/command-runner')
    const nodeOptions = withCiPreloads('', { framework: 'vitest' }, {
      cwd: process.cwd(),
      argv: ['/opt/node/18.18.0/bin/node', 'node_modules/.bin/vitest', 'run'],
    })

    assert.doesNotMatch(nodeOptions, /--import/)
    assert.match(nodeOptions, /[\\/]ci[\\/]init\.js/)
  })

  it('injects --import for Vitest package-manager commands without running a hidden version probe', () => {
    const { withCiPreloads } = proxyquire('../../../../ci/test-optimization-validation/command-runner', {
      child_process: {
        spawn: childProcess.spawn,
      },
    })
    const nodeOptions = withCiPreloads('', { framework: 'vitest' }, {
      cwd: process.cwd(),
      argv: ['pnpm', 'run', 'test'],
    })

    assert.match(nodeOptions, /--import/)
    assert.match(nodeOptions, /[\\/]register\.js/)
    assert.match(nodeOptions, /[\\/]ci[\\/]init\.js/)
  })

  it('injects --import for Vitest shell commands using the validator Node version', () => {
    const { withCiPreloads } = require('../../../../ci/test-optimization-validation/command-runner')
    const nodeOptions = withCiPreloads('', { framework: 'vitest' }, {
      cwd: process.cwd(),
      usesShell: true,
      shellCommand: 'pnpm run test',
    })

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

  it('does not add ambient NODE_OPTIONS to forced local validation', () => {
    const originalNodeOptions = process.env.NODE_OPTIONS
    process.env.NODE_OPTIONS = '--no-warnings'

    try {
      const env = buildDatadogEnv({
        intake: { port: 1234 },
        scenario: 'basic-reporting',
        framework: { framework: 'mocha' },
      })

      assert.doesNotMatch(env.NODE_OPTIONS, /--no-warnings/)
      assert.match(env.NODE_OPTIONS, /[\\/]ci[\\/]init\.js/)
    } finally {
      if (originalNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS
      } else {
        process.env.NODE_OPTIONS = originalNodeOptions
      }
    }
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
    assert.match(env.NODE_OPTIONS, /transport-preload\.js/)
    assert.doesNotMatch(env.NODE_OPTIONS, /[\\/]ci[\\/]init\.js/)
  })

  it('reapplies fake-intake transport before CI-provided NODE_OPTIONS', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-command-runner-'))
    const env = buildCiWiringEnv({ intake: { port: 43123 } })

    try {
      const result = await runCommand({
        cwd: outDir,
        argv: [
          process.execPath,
          '-e',
          'process.stdout.write(JSON.stringify({' +
            'agentUrl: process.env.DD_TRACE_AGENT_URL,' +
            'agentlessUrl: process.env.DD_CIVISIBILITY_AGENTLESS_URL,' +
            'nodeOptions: process.env.NODE_OPTIONS' +
          '}))',
        ],
        env: {
          DD_TRACE_AGENT_URL: 'https://example.invalid',
          NODE_OPTIONS: '--no-warnings',
        },
      }, {
        env,
        envMode: 'clean',
        outDir,
      })
      const observed = JSON.parse(result.stdout)

      assert.strictEqual(observed.agentUrl, 'http://127.0.0.1:43123')
      assert.strictEqual(observed.agentlessUrl, 'http://127.0.0.1:43123')
      assert.ok(observed.nodeOptions.indexOf('transport-preload.js') < observed.nodeOptions.indexOf('--no-warnings'))
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true })
    }
  })

  it('refuses inline fake-intake and NODE_OPTIONS overrides', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-command-runner-'))
    const env = buildCiWiringEnv({ intake: { port: 43123 } })

    try {
      await assert.rejects(runCommand({
        cwd: outDir,
        usesShell: true,
        shellCommand: 'NODE_OPTIONS="-r dd-trace/ci/init" npm test',
      }, {
        env,
        envMode: 'clean',
        outDir,
      }), /Refusing inline NODE_OPTIONS changes/)

      await assert.rejects(runCommand({
        cwd: outDir,
        argv: ['/usr/bin/env', 'DD_TRACE_AGENT_URL=https://example.invalid', 'npm', 'test'],
      }, {
        env,
        envMode: 'clean',
        outDir,
      }), /Refusing inline DD_TRACE_AGENT_URL changes/)

      await assert.rejects(runCommand({
        cwd: outDir,
        argv: ['/usr/bin/env', '--unset=NODE_OPTIONS', 'npm', 'test'],
      }, {
        env,
        envMode: 'clean',
        outDir,
      }), /Refusing inline NODE_OPTIONS changes/)

      await assert.rejects(runCommand({
        cwd: outDir,
        argv: ['/usr/bin/env', '-S', 'NODE_OPTIONS=--no-warnings node test.js'],
      }, {
        env,
        envMode: 'clean',
        outDir,
      }), /Refusing inline NODE_OPTIONS changes/)

      await assert.rejects(runCommand({
        cwd: outDir,
        argv: ['/usr/bin/env', '--split-string=DD_TRACE_AGENT_URL=https://example.invalid node test.js'],
      }, {
        env,
        envMode: 'clean',
        outDir,
      }), /Refusing inline DD_TRACE_AGENT_URL changes/)

      await assert.rejects(runCommand({
        cwd: outDir,
        argv: ['/usr/bin/env', '-i', 'PATH=/usr/bin', 'npm', 'test'],
      }, {
        env,
        envMode: 'clean',
        outDir,
      }), /Refusing to clear the command environment/)

      await assert.rejects(runCommand({
        cwd: outDir,
        usesShell: true,
        shellCommand: 'env --unset=NODE_OPTIONS npm test',
      }, {
        env,
        envMode: 'clean',
        outDir,
      }), /Refusing inline NODE_OPTIONS changes/)

      await assert.rejects(runCommand({
        cwd: outDir,
        usesShell: true,
        shellCommand: 'env --ignore-environment PATH=/usr/bin npm test',
      }, {
        env,
        envMode: 'clean',
        outDir,
      }), /Refusing to clear the command environment/)
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true })
    }
  })

  it('does not move declared outputs before inline environment validation', async () => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-command-output-'))
    const artifactRoot = path.join(repositoryRoot, 'results')
    const outDir = path.join(artifactRoot, 'run')
    const coverage = path.join(repositoryRoot, 'coverage')
    const env = buildCiWiringEnv({ intake: { port: 43123 } })
    fs.mkdirSync(artifactRoot)
    fs.mkdirSync(coverage)
    fs.writeFileSync(path.join(coverage, 'original.txt'), 'original')

    try {
      await assert.rejects(runCommand({
        cwd: repositoryRoot,
        argv: ['/usr/bin/env', 'NODE_OPTIONS=--no-warnings', process.execPath, '-e', ''],
        outputPaths: [coverage],
      }, {
        artifactRoot,
        env,
        envMode: 'clean',
        outDir,
        repositoryRoot,
      }), /Refusing inline NODE_OPTIONS changes/)

      assert.strictEqual(fs.readFileSync(path.join(coverage, 'original.txt'), 'utf8'), 'original')
      assert.strictEqual(fs.existsSync(path.join(outDir, '.command-output-backup')), false)
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true })
    }
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

  it('renders the executable argv for approval without trusting displayCommand', () => {
    assert.strictEqual(serializeApprovalCommand({
      argv: ['sh', '-c', 'printf "actual command"'],
      displayCommand: 'npm test',
    }), 'sh -c "printf \\"actual command\\""')
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

  it('stops argv command process groups when diagnostic evidence is complete', async function () {
    if (process.platform === 'win32') this.skip()

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-command-runner-'))
    const marker = path.join(outDir, 'early-stop-child-survived')
    const childScript = [
      'process.on("SIGTERM", () => {})',
      `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"), 750)`,
      'setInterval(() => {}, 1000)',
    ].join(';')
    const parentScript = [
      'const { spawn } = require("node:child_process")',
      `spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(childScript)}], { stdio: "ignore" })`,
      'setInterval(() => {}, 1000)',
    ].join(';')
    const startedAt = Date.now()

    try {
      const result = await runCommand({
        cwd: outDir,
        argv: [process.execPath, '-e', parentScript],
        timeoutMs: 5000,
      }, {
        outDir,
        stopWhen: () => Date.now() - startedAt >= 150,
      })

      await new Promise(resolve => setTimeout(resolve, 700))

      assert.strictEqual(result.stoppedEarly, true)
      assert.strictEqual(result.timedOut, false)
      assert.ok(result.durationMs < 2000)
      assert.strictEqual(fs.existsSync(marker), false)
      const commandArtifact = JSON.parse(fs.readFileSync(path.join(outDir, 'command.json'), 'utf8'))
      assert.strictEqual(commandArtifact.stoppedEarly, true)
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

  it('caps command stdout and stderr artifacts to bounded tails', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-command-runner-'))

    try {
      const result = await runCommand({
        cwd: outDir,
        argv: [
          process.execPath,
          '-e',
          [
            'process.stdout.write("stdout-start-" + "a".repeat(80) + "-stdout-end")',
            'process.stderr.write("stderr-start-" + "b".repeat(80) + "-stderr-end")',
          ].join(';'),
        ],
        maxOutputBytes: 32,
        timeoutMs: 1000,
      }, {
        outDir,
      })

      assert.strictEqual(result.stdoutTruncated, true)
      assert.strictEqual(result.stderrTruncated, true)
      assert.match(result.stdout, /stdout-end$/)
      assert.match(result.stderr, /stderr-end$/)
      assert.doesNotMatch(result.stdout, /stdout-start/)
      assert.doesNotMatch(result.stderr, /stderr-start/)

      const stdoutArtifact = fs.readFileSync(path.join(outDir, 'stdout.txt'), 'utf8')
      const stderrArtifact = fs.readFileSync(path.join(outDir, 'stderr.txt'), 'utf8')
      const commandArtifact = JSON.parse(fs.readFileSync(path.join(outDir, 'command.json'), 'utf8'))

      assert.match(stdoutArtifact, /output truncated to last 32 bytes/)
      assert.match(stderrArtifact, /output truncated to last 32 bytes/)
      assert.strictEqual(commandArtifact.stdoutTruncated, true)
      assert.strictEqual(commandArtifact.stderrTruncated, true)
      assert.strictEqual(commandArtifact.maxOutputBytes, 32)
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true })
    }
  })

  it('restores a pre-existing coverage directory after an approved coverage command', async () => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-command-output-'))
    const artifactRoot = path.join(repositoryRoot, 'results')
    const outDir = path.join(artifactRoot, 'run')
    const coverage = path.join(repositoryRoot, 'coverage')
    fs.mkdirSync(artifactRoot)
    fs.mkdirSync(coverage)
    fs.writeFileSync(path.join(coverage, 'original.txt'), 'original')

    try {
      const result = await runCommand({
        cwd: repositoryRoot,
        argv: [
          process.execPath,
          '-e',
          'require("node:fs").mkdirSync("coverage", { recursive: true }); ' +
            'require("node:fs").writeFileSync("coverage/new.txt", "new")',
          '--',
          '--coverage',
        ],
      }, { artifactRoot, outDir, repositoryRoot })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(fs.readFileSync(path.join(coverage, 'original.txt'), 'utf8'), 'original')
      assert.strictEqual(fs.existsSync(path.join(coverage, 'new.txt')), false)
      assert.deepStrictEqual(result.commandOutputPaths, [{ outputPath: coverage, action: 'restored' }])
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true })
    }
  })

  it('removes a newly created coverage directory after an approved coverage command', async () => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-command-output-'))
    const artifactRoot = path.join(repositoryRoot, 'results')
    const outDir = path.join(artifactRoot, 'run')
    fs.mkdirSync(artifactRoot)

    try {
      const result = await runCommand({
        cwd: repositoryRoot,
        argv: [
          process.execPath,
          '-e',
          'require("node:fs").mkdirSync("coverage", { recursive: true })',
          '--',
          '--coverage',
        ],
      }, { artifactRoot, outDir, repositoryRoot })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(fs.existsSync(path.join(repositoryRoot, 'coverage')), false)
      assert.deepStrictEqual(result.commandOutputPaths, [{
        outputPath: path.join(repositoryRoot, 'coverage'),
        action: 'removed',
      }])
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true })
    }
  })

  it('restores earlier outputs when a later declared output is unsafe', () => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-command-output-'))
    const artifactRoot = path.join(repositoryRoot, 'results')
    const outDir = path.join(artifactRoot, 'run')
    const coverage = path.join(repositoryRoot, 'coverage')
    fs.mkdirSync(artifactRoot)
    fs.mkdirSync(coverage)
    fs.writeFileSync(path.join(coverage, 'original.txt'), 'original')

    try {
      assert.throws(() => runCommand({
        cwd: repositoryRoot,
        argv: [process.execPath, '-e', ''],
        outputPaths: [coverage, path.join(repositoryRoot, '..', 'outside')],
      }, { artifactRoot, outDir, repositoryRoot }), /must be a child of repository\.root/)
      assert.strictEqual(fs.readFileSync(path.join(coverage, 'original.txt'), 'utf8'), 'original')
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true })
    }
  })

  it('rejects command outputs reached through a symlinked repository path', () => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-command-output-'))
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-command-output-outside-'))
    const artifactRoot = path.join(repositoryRoot, 'results')
    const outDir = path.join(artifactRoot, 'run')
    const linkedDirectory = path.join(repositoryRoot, 'linked-output')
    const outsideCoverage = path.join(outsideRoot, 'coverage')
    fs.mkdirSync(artifactRoot)
    fs.mkdirSync(outsideCoverage)
    fs.writeFileSync(path.join(outsideCoverage, 'original.txt'), 'original')
    fs.symlinkSync(outsideRoot, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir')

    try {
      assert.throws(() => runCommand({
        cwd: repositoryRoot,
        argv: [process.execPath, '-e', ''],
        outputPaths: [path.join(linkedDirectory, 'coverage')],
      }, { artifactRoot, outDir, repositoryRoot }), /outside physical repository\.root/)
      assert.strictEqual(fs.readFileSync(path.join(outsideCoverage, 'original.txt'), 'utf8'), 'original')
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true })
      fs.rmSync(outsideRoot, { recursive: true, force: true })
    }
  })

  it('keeps toolchain env but drops ambient instrumentation from clean env', () => {
    const originalVoltaHome = process.env.VOLTA_HOME
    const originalNodeOptions = process.env.NODE_OPTIONS
    const originalOtelTracesExporter = process.env.OTEL_TRACES_EXPORTER

    process.env.VOLTA_HOME = '/Users/example/.volta'
    process.env.NODE_OPTIONS = '-r dd-trace/ci/init'
    process.env.OTEL_TRACES_EXPORTER = 'otlp'

    try {
      const cleanEnv = getBaseEnv('clean')

      assert.strictEqual(cleanEnv.VOLTA_HOME, '/Users/example/.volta')
      assert.strictEqual(cleanEnv.NODE_OPTIONS, undefined)
      assert.strictEqual(cleanEnv.OTEL_TRACES_EXPORTER, undefined)
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

      if (originalOtelTracesExporter === undefined) {
        delete process.env.OTEL_TRACES_EXPORTER
      } else {
        process.env.OTEL_TRACES_EXPORTER = originalOtelTracesExporter
      }
    }
  })
})
