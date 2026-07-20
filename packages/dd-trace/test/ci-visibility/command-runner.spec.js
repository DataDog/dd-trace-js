'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { PassThrough } = require('node:stream')

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
  withCiPreloads,
} = require('../../../../ci/test-optimization-validation/command-runner')

function validationRouting () {
  return {
    fixture: { manifestPath: path.join(os.tmpdir(), 'validation-manifest.txt') },
    outputRoot: path.join(os.tmpdir(), 'validation-payloads'),
  }
}

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

  it('injects both required Vitest preloads without inferring the command Node.js version', () => {
    const nodeOptions = withCiPreloads('', { framework: 'vitest' })

    assert.match(nodeOptions, /--import/)
    assert.match(nodeOptions, /[\\/]register\.js/)
    assert.match(nodeOptions, /[\\/]ci[\\/]init\.js/)
  })

  it('does not override argv0 when launching a verified executable on Windows', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-windows-spawn-'))
    const out = path.join(root, 'results')
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    let spawnOptions

    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      const { runCommand } = proxyquire('../../../../ci/test-optimization-validation/command-runner', {
        child_process: {
          spawn (executable, args, options) {
            spawnOptions = options
            const child = new EventEmitter()
            child.kill = () => {}
            child.pid = 1
            child.stderr = new PassThrough()
            child.stdout = new PassThrough()
            process.nextTick(() => child.emit('close', 0, null))
            return child
          },
        },
      })

      await runCommand({
        cwd: root,
        argv: [process.execPath, '-e', ''],
      }, {
        artifactRoot: root,
        outDir: out,
        repositoryRoot: root,
      })

      assert.strictEqual(Object.hasOwn(spawnOptions, 'argv0'), false)
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('disables unrelated Datadog side channels during forced local validation', () => {
    const env = buildDatadogEnv({
      ...validationRouting(),
      scenario: 'basic-reporting',
      framework: { framework: 'mocha' },
    })

    assert.strictEqual(env.DD_CIVISIBILITY_GIT_UPLOAD_ENABLED, 'false')
    assert.strictEqual(env.DD_CIVISIBILITY_GIT_UNSHALLOW_ENABLED, 'false')
    assert.strictEqual(env.DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED, 'false')
    assert.strictEqual(env.DD_AGENTLESS_LOG_SUBMISSION_ENABLED, 'false')
    assert.strictEqual(env.DD_APPSEC_ENABLED, 'false')
    assert.strictEqual(env.DD_CRASHTRACKING_ENABLED, 'false')
    assert.strictEqual(env.DD_DATA_STREAMS_ENABLED, 'false')
    assert.strictEqual(env.DD_DYNAMIC_INSTRUMENTATION_ENABLED, 'false')
    assert.strictEqual(env.DD_EXPERIMENTAL_APPSEC_STANDALONE_ENABLED, 'false')
    assert.strictEqual(env.DD_EXPERIMENTAL_FLAGGING_PROVIDER_ENABLED, 'false')
    assert.strictEqual(env.DD_HEAP_SNAPSHOT_COUNT, '0')
    assert.strictEqual(env.DD_IAST_ENABLED, 'false')
    assert.strictEqual(env.DD_INSTRUMENTATION_TELEMETRY_ENABLED, 'false')
    assert.strictEqual(env.DD_LLMOBS_ENABLED, 'false')
    assert.strictEqual(env.DD_LOGS_OTEL_ENABLED, 'false')
    assert.strictEqual(env.DD_METRICS_OTEL_ENABLED, 'false')
    assert.strictEqual(env.DD_PROFILING_ENABLED, 'false')
    assert.strictEqual(env.DD_REMOTE_CONFIGURATION_ENABLED, 'false')
    assert.strictEqual(env.DD_RUNTIME_METRICS_ENABLED, 'false')
    assert.strictEqual(env.DD_TRACE_OTEL_ENABLED, 'false')
    assert.strictEqual(env.DD_TRACE_SPAN_LEAK_DEBUG, '0')
    assert.strictEqual(env.OTEL_LOGS_EXPORTER, undefined)
    assert.strictEqual(env.OTEL_METRICS_EXPORTER, undefined)
    assert.strictEqual(env.OTEL_TRACES_EXPORTER, undefined)
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
        ...validationRouting(),
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

  it('uses private filesystem routing without adding Datadog initialization to CI replay', () => {
    const env = buildCiWiringEnv(validationRouting())

    assert.strictEqual(env._DD_TEST_OPTIMIZATION_VALIDATION_MODE, '1')
    assert.strictEqual(env._DD_TEST_OPTIMIZATION_VALIDATION_MANIFEST_FILE,
      validationRouting().fixture.manifestPath)
    assert.strictEqual(env._DD_TEST_OPTIMIZATION_VALIDATION_OUTPUT_DIR, validationRouting().outputRoot)
    assert.strictEqual(env.DD_CIVISIBILITY_GIT_UPLOAD_ENABLED, 'false')
    assert.strictEqual(env.DD_INSTRUMENTATION_TELEMETRY_ENABLED, 'false')
    assert.strictEqual(env.DD_CIVISIBILITY_ENABLED, undefined)
    assert.strictEqual(env.DD_EXPERIMENTAL_TEST_OPT_SETTINGS_CACHE, undefined)
    assert.strictEqual(env.NODE_OPTIONS, undefined)
    assert.strictEqual(env.DD_TRACE_AGENT_URL, undefined)
    assert.strictEqual(env.DD_API_KEY, undefined)
    assert.strictEqual(env.DD_APP_KEY, undefined)
    assert.strictEqual(env.DATADOG_API_KEY, undefined)
  })

  it('keeps validator-controlled offline paths when a command supplies conflicting environment values', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-command-runner-'))
    const settingsCachePath = path.join(outDir, 'project-selected-settings-cache.json')
    const env = buildCiWiringEnv(validationRouting())

    try {
      const result = await runCommand({
        cwd: outDir,
        argv: [process.execPath, '-e', [
          'if (process.env.DD_EXPERIMENTAL_TEST_OPT_SETTINGS_CACHE) ',
          '  require("node:fs").writeFileSync(process.env.DD_EXPERIMENTAL_TEST_OPT_SETTINGS_CACHE, "unexpected");',
          'process.stdout.write(JSON.stringify({',
          '  manifest: process.env._DD_TEST_OPTIMIZATION_VALIDATION_MANIFEST_FILE,',
          '  output: process.env._DD_TEST_OPTIMIZATION_VALIDATION_OUTPUT_DIR,',
          '  apmAgentless: process.env._DD_APM_TRACING_AGENTLESS_ENABLED,',
          '  settingsCache: process.env.DD_EXPERIMENTAL_TEST_OPT_SETTINGS_CACHE,',
          '  otelTraces: process.env.OTEL_TRACES_EXPORTER,',
          '  profiling: process.env.DD_PROFILING_ENABLED,',
          '  runtimeMetrics: process.env.DD_RUNTIME_METRICS_ENABLED',
          '}))',
        ].join('')],
        env: {
          _DD_TEST_OPTIMIZATION_VALIDATION_MANIFEST_FILE: '/tmp/unapproved-manifest',
          _DD_TEST_OPTIMIZATION_VALIDATION_OUTPUT_DIR: '/tmp/unapproved-output',
          _DD_APM_TRACING_AGENTLESS_ENABLED: 'true',
          DD_EXPERIMENTAL_TEST_OPT_SETTINGS_CACHE: settingsCachePath,
          DD_PROFILING_ENABLED: 'true',
          DD_RUNTIME_METRICS_ENABLED: 'true',
          OTEL_TRACES_EXPORTER: 'otlp',
        },
      }, {
        env,
        envMode: 'clean',
        outDir,
      })
      const observed = JSON.parse(result.stdout)

      assert.strictEqual(observed.manifest, validationRouting().fixture.manifestPath)
      assert.strictEqual(observed.output, validationRouting().outputRoot)
      assert.strictEqual(observed.apmAgentless, undefined)
      assert.strictEqual(observed.settingsCache, undefined)
      assert.strictEqual(observed.otelTraces, undefined)
      assert.strictEqual(observed.profiling, 'false')
      assert.strictEqual(observed.runtimeMetrics, 'false')
      assert.strictEqual(fs.existsSync(settingsCachePath), false)
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true })
    }
  })

  it('refuses inline offline routing, NODE_OPTIONS, and environment resets', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-command-runner-'))
    const env = buildCiWiringEnv(validationRouting())

    try {
      await assert.rejects(runCommand({
        cwd: outDir,
        usesShell: true,
        shellCommand: '_DD_TEST_OPTIMIZATION_VALIDATION_OUTPUT_DIR=/tmp/other npm test',
      }, { env, envMode: 'clean', outDir }), /Refusing inline _DD_TEST_OPTIMIZATION_VALIDATION_OUTPUT_DIR changes/)

      await assert.rejects(runCommand({
        cwd: outDir,
        usesShell: true,
        shellCommand: 'DD_EXPERIMENTAL_TEST_OPT_SETTINGS_CACHE=/tmp/other npm test',
      }, { env, envMode: 'clean', outDir }), /Refusing inline DD_EXPERIMENTAL_TEST_OPT_SETTINGS_CACHE changes/)

      await assert.rejects(runCommand({
        cwd: outDir,
        argv: ['/usr/bin/env', '--unset=NODE_OPTIONS', 'npm', 'test'],
      }, { env, envMode: 'clean', outDir }), /Refusing inline NODE_OPTIONS changes/)

      await assert.rejects(runCommand({
        cwd: outDir,
        argv: ['/usr/bin/env', '--unset=DD_EXPERIMENTAL_TEST_OPT_SETTINGS_CACHE', 'npm', 'test'],
      }, { env, envMode: 'clean', outDir }), /Refusing inline DD_EXPERIMENTAL_TEST_OPT_SETTINGS_CACHE changes/)

      await assert.rejects(runCommand({
        cwd: outDir,
        argv: ['/usr/bin/env', '--ignore-environment', 'npm', 'test'],
      }, { env, envMode: 'clean', outDir }), /Refusing to clear the command environment/)

      await assert.rejects(runCommand({
        cwd: outDir,
        usesShell: true,
        shellCommand: 'unset UNRELATED NODE_OPTIONS; npm test',
      }, { env, envMode: 'clean', outDir }), /Refusing inline NODE_OPTIONS changes/)

      await assert.rejects(runCommand({
        cwd: outDir,
        usesShell: true,
        shellCommand: 'NODE_OPTIONS+=--no-warnings npm test',
      }, { env, envMode: 'clean', outDir }), /Refusing inline NODE_OPTIONS changes/)

      await assert.rejects(runCommand({
        cwd: outDir,
        usesShell: true,
        shellCommand: '$env:NODE_OPTIONS += " --no-warnings"; npm test',
      }, { env, envMode: 'clean', outDir }), /Refusing inline NODE_OPTIONS changes/)

      await assert.rejects(runCommand({
        cwd: outDir,
        usesShell: true,
        shellCommand: "export NO'DE'_OPTIONS=--no-warnings; npm test",
      }, { env, envMode: 'clean', outDir }), /Refusing inline NODE_OPTIONS changes/)

      await assert.rejects(runCommand({
        cwd: outDir,
        usesShell: true,
        shellCommand: "'NODE_OPTIONS'=--no-warnings npm test",
      }, { env, envMode: 'clean', outDir }), /Refusing inline NODE_OPTIONS changes/)
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true })
    }
  })

  it('returns a failed result when command artifacts cannot be written after exit', async () => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-command-artifact-write-'))
    const artifactRoot = path.join(repositoryRoot, 'results')
    const outDir = path.join(artifactRoot, 'run')
    fs.mkdirSync(artifactRoot)

    try {
      const result = await runCommand({
        cwd: repositoryRoot,
        argv: [
          process.execPath,
          '-e',
          `require('node:fs').rmSync(${JSON.stringify(artifactRoot)}, { recursive: true, force: true })`,
        ],
      }, {
        artifactRoot,
        outDir,
        repositoryRoot,
      })

      assert.strictEqual(result.exitCode, 1)
      assert.match(result.artifactWriteError, /ENOENT|no such file or directory/i)
      assert.match(result.stderr, /could not write command artifacts/)
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true })
    }
  })

  it('does not move declared outputs before inline environment validation', async () => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-command-output-'))
    const artifactRoot = path.join(repositoryRoot, 'results')
    const outDir = path.join(artifactRoot, 'run')
    const coverage = path.join(repositoryRoot, 'coverage')
    const env = buildCiWiringEnv(validationRouting())
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
    const quotedCommand = process.platform === 'win32'
      ? '"printf \\"actual command\\""'
      : String.raw`'printf "actual command"'`

    assert.strictEqual(serializeApprovalCommand({
      argv: ['sh', '-c', 'printf "actual command"'],
      displayCommand: 'npm test',
    }), `sh -c ${quotedCommand}`)
  })

  it('single-quotes POSIX approval arguments containing shell expansions', function () {
    if (process.platform === 'win32') this.skip()

    assert.strictEqual(serializeApprovalCommand({
      argv: ['node', '-e', '$(touch /tmp/approval-marker)'],
    }), "node -e '$(touch /tmp/approval-marker)'")
    assert.strictEqual(serializeApprovalCommand({
      argv: ['node', String.raw`it's $(still-literal)`],
    }), String.raw`node 'it'"'"'s $(still-literal)'`)
  })

  it('keeps POSIX shell expansions literal when a rendered approval command is copied', function () {
    if (process.platform === 'win32') this.skip()

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-approval-command-'))
    const marker = path.join(root, 'unexpected-expansion')
    const output = path.join(root, 'argument.txt')
    const literalArgument = `$(touch ${marker})`
    const command = serializeApprovalCommand({
      argv: [
        process.execPath,
        '-e',
        'require("node:fs").writeFileSync(process.argv[1], process.argv[2])',
        output,
        literalArgument,
      ],
    })

    try {
      execFileSync('/bin/sh', ['-c', command])

      assert.strictEqual(fs.readFileSync(output, 'utf8'), literalArgument)
      assert.strictEqual(fs.existsSync(marker), false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
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
      assert.match(result.stderr, /Command executable is unavailable/)
      assert.strictEqual(fs.existsSync(path.join(outDir, 'command.json')), false)
      assert.strictEqual(fs.existsSync(path.join(outDir, 'stderr.txt')), false)
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true })
    }
  })

  it('refuses an executable that is not covered by a required approval', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-command-runner-'))

    try {
      const result = await runCommand({
        cwd: outDir,
        argv: [process.execPath, '-e', 'process.exit(0)'],
      }, {
        outDir,
        requireExecutableApproval: true,
      })

      assert.strictEqual(result.exitCode, null)
      assert.match(result.stderr, /not covered by the approved execution plan/)
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
        timeoutFinalizeGraceMs: 5000,
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

  it('caps command stdout and stderr artifacts to bounded heads and tails', async () => {
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
      assert.match(result.stdout, /^stdout-start/)
      assert.match(result.stderr, /^stderr-start/)
      assert.match(result.stdout, /stdout-end$/)
      assert.match(result.stderr, /stderr-end$/)
      assert.ok(result.stdoutOmittedBytes > 0)
      assert.ok(result.stderrOmittedBytes > 0)

      const stdoutArtifact = fs.readFileSync(path.join(outDir, 'stdout.txt'), 'utf8')
      const stderrArtifact = fs.readFileSync(path.join(outDir, 'stderr.txt'), 'utf8')
      const commandArtifact = JSON.parse(fs.readFileSync(path.join(outDir, 'command.json'), 'utf8'))

      assert.match(stdoutArtifact, /\d+ bytes omitted/)
      assert.match(stderrArtifact, /\d+ bytes omitted/)
      assert.strictEqual(commandArtifact.stdoutTruncated, true)
      assert.strictEqual(commandArtifact.stderrTruncated, true)
      assert.ok(commandArtifact.stdoutOmittedBytes > 0)
      assert.ok(commandArtifact.stderrOmittedBytes > 0)
      assert.strictEqual(commandArtifact.maxOutputBytes, 32)
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true })
    }
  })

  it('refuses to move or overwrite a pre-existing coverage directory', async () => {
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
        argv: [
          process.execPath,
          '-e',
          'require("node:fs").mkdirSync("coverage", { recursive: true }); ' +
            'require("node:fs").writeFileSync("coverage/new.txt", "new")',
          '--',
          '--coverage',
        ],
      }, { artifactRoot, outDir, repositoryRoot }), /already exists and will not be moved or overwritten/)
      assert.strictEqual(fs.readFileSync(path.join(coverage, 'original.txt'), 'utf8'), 'original')
      assert.strictEqual(fs.existsSync(path.join(coverage, 'new.txt')), false)
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true })
    }
  })

  it('refuses a dangling symbolic link at a declared command output', function () {
    if (process.platform === 'win32') this.skip()

    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-command-output-'))
    const artifactRoot = path.join(repositoryRoot, 'results')
    const outDir = path.join(artifactRoot, 'run')
    const coverage = path.join(repositoryRoot, 'coverage')
    const missingTarget = path.join(repositoryRoot, 'missing-target')
    fs.mkdirSync(artifactRoot)
    fs.symlinkSync(missingTarget, coverage)

    try {
      assert.throws(() => runCommand({
        cwd: repositoryRoot,
        argv: [process.execPath, '-e', 'throw new Error("must not run")'],
        outputPaths: [coverage],
      }, { artifactRoot, outDir, repositoryRoot }), /already exists and will not be moved or overwritten/)
      assert.strictEqual(fs.lstatSync(coverage).isSymbolicLink(), true)
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

  it('removes a newly created nyc output directory recursively', async () => {
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
          'const fs = require("node:fs"); fs.mkdirSync(".nyc_output", { recursive: true }); ' +
            'fs.writeFileSync(".nyc_output/process.json", "{}")',
          'nyc',
        ],
      }, { artifactRoot, outDir, repositoryRoot })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(fs.existsSync(path.join(repositoryRoot, '.nyc_output')), false)
      assert.deepStrictEqual(result.commandOutputPaths, [{
        outputPath: path.join(repositoryRoot, '.nyc_output'),
        action: 'removed',
      }])
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true })
    }
  })

  it('honors a custom nyc temp directory without touching the default output', async () => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-command-output-'))
    const artifactRoot = path.join(repositoryRoot, 'results')
    const outDir = path.join(artifactRoot, 'run')
    const defaultOutput = path.join(repositoryRoot, '.nyc_output')
    const customOutput = path.join(repositoryRoot, 'tmp', 'nyc')
    fs.mkdirSync(artifactRoot)
    fs.mkdirSync(defaultOutput)
    fs.writeFileSync(path.join(defaultOutput, 'original.json'), '{}')

    try {
      const result = await runCommand({
        cwd: repositoryRoot,
        argv: [
          process.execPath,
          '-e',
          'require("node:fs").mkdirSync("tmp/nyc", { recursive: true })',
          'nyc',
          '--temp-dir',
          'tmp/nyc',
        ],
      }, { artifactRoot, outDir, repositoryRoot })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(fs.existsSync(customOutput), false)
      assert.strictEqual(fs.existsSync(path.join(defaultOutput, 'original.json')), true)
      assert.deepStrictEqual(result.commandOutputPaths, [{
        outputPath: customOutput,
        action: 'removed',
      }])
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true })
    }
  })

  it('does not treat wrapped runner options as nyc temp-directory options', async () => {
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
          'require("node:fs").mkdirSync(".nyc_output", { recursive: true })',
          'nyc',
          'mocha',
          '-t',
          '10000',
        ],
      }, { artifactRoot, outDir, repositoryRoot })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(fs.existsSync(path.join(repositoryRoot, '.nyc_output')), false)
      assert.deepStrictEqual(result.commandOutputPaths, [{
        outputPath: path.join(repositoryRoot, '.nyc_output'),
        action: 'removed',
      }])
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true })
    }
  })

  it('fails closed when a command replaces an output parent before cleanup', async function () {
    if (process.platform === 'win32') this.skip()

    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-command-output-'))
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-command-output-outside-'))
    const artifactRoot = path.join(repositoryRoot, 'results')
    const outDir = path.join(artifactRoot, 'run')
    const outputParent = path.join(repositoryRoot, 'generated')
    const outputPath = path.join(outputParent, 'coverage')
    const outsideMarker = path.join(outsideRoot, 'keep.txt')
    fs.mkdirSync(artifactRoot)
    fs.mkdirSync(outputParent)
    fs.writeFileSync(outsideMarker, 'keep')

    const script = [
      'const fs = require("node:fs")',
      `fs.renameSync(${JSON.stringify(outputParent)}, ${JSON.stringify(`${outputParent}-original`)})`,
      `fs.symlinkSync(${JSON.stringify(outsideRoot)}, ${JSON.stringify(outputParent)}, "dir")`,
      `fs.mkdirSync(${JSON.stringify(outputPath)})`,
    ].join(';')

    try {
      const result = await runCommand({
        cwd: repositoryRoot,
        argv: [process.execPath, '-e', script],
        outputPaths: [outputPath],
      }, { artifactRoot, outDir, repositoryRoot })

      assert.strictEqual(result.exitCode, 1)
      assert.match(result.outputCleanupError, /non-regular directory|parent directory changed/)
      assert.strictEqual(fs.readFileSync(outsideMarker, 'utf8'), 'keep')
      assert.strictEqual(fs.existsSync(path.join(outsideRoot, 'coverage')), true)
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true })
      fs.rmSync(outsideRoot, { recursive: true, force: true })
    }
  })

  it('does not modify pre-existing outputs when a later declared output is unsafe', () => {
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
