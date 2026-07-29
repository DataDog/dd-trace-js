'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const childProcess = require('node:child_process')
const proxyquire = require('proxyquire').noPreserveCache()

const {
  buildDatadogEnv,
  runCommand,
  serializeApprovalCommand,
  withCiPreloads,
} = require('../../../../ci/test-optimization-validation/command-runner')
const {
  bindManifestExecutables,
  getExecutableForSpawn,
} = require('../../../../ci/test-optimization-validation/executable')
const {
  verifyGeneratedTestStrategy,
} = require('../../../../ci/test-optimization-validation/generated-verifier')
const { runFrameworkPreflight } = require('../../../../ci/test-optimization-validation/preflight-runner')
const { getBasicCommand } = require('../../../../ci/test-optimization-validation/runner-command')
const {
  createLoadedManifest,
  createRepositoryFixture,
  createWindowsFileReferenceFs,
  removeFixture,
} = require('./validation-test-helpers')

describe('test optimization validation execution boundary', () => {
  let fixture
  let manifest
  let framework
  let out

  beforeEach(() => {
    fixture = createRepositoryFixture({
      framework: 'mocha',
      runnerSource: "console.log('1 passing')\n",
    })
    manifest = createLoadedManifest(fixture.root, 'mocha')
    framework = manifest.frameworks[0]
    out = path.join(fixture.root, 'dd-test-optimization-validation-results')
    fs.mkdirSync(out, { recursive: true })
  })

  afterEach(() => removeFixture(fixture.root))

  it('executes only node plus the repository-contained runner and one test', async () => {
    const command = getBasicCommand(framework)
    const result = await execute(command, 'direct')

    assert.deepStrictEqual(command.argv.slice(0, 2), [process.execPath, fs.realpathSync(fixture.runner)])
    assert.ok(command.argv.includes(fixture.testFile))
    assert.strictEqual(result.exitCode, 0)
    assert.match(result.stdout, /1 passing/)
    assert.strictEqual(result.commandDetails.executionBoundary, 'validator-owned-direct-runner')
  })

  for (const command of [
    { cwd: '/', usesShell: false, argv: ['npm', 'test'] },
    { cwd: '/', usesShell: true, argv: [process.execPath, '/tmp/runner.js', '/tmp/test.js'] },
  ]) {
    it(`refuses unsupported command shape ${JSON.stringify(command.argv)}`, async () => {
      const result = await runCommand(command, {
        artifactRoot: out,
        outDir: path.join(out, `invalid-${Math.random()}`),
        repositoryRoot: fixture.root,
      })

      assert.strictEqual(result.exitCode, null)
      assert.match(result.stderr, /Only validator-owned/)
    })
  }

  it('refuses a runner that physically resolves outside the repository', async () => {
    const external = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-runner-')))
    const runner = path.join(external, 'runner.js')
    fs.writeFileSync(runner, 'process.exit(0)\n')
    const command = {
      ...getBasicCommand(framework),
      argv: [process.execPath, runner, fixture.testFile],
    }

    try {
      const result = await execute(command, 'outside')
      assert.strictEqual(result.exitCode, null)
      assert.match(result.stderr, /resolves outside repository\.root/)
    } finally {
      fs.rmSync(external, { force: true, recursive: true })
    }
  })

  it('revalidates Node and runner fingerprints immediately before execution', () => {
    bindManifestExecutables(manifest)
    const command = getBasicCommand(framework)
    assert.strictEqual(
      getExecutableForSpawn(command, { requireApproval: true }).path,
      fs.realpathSync(process.execPath)
    )

    fs.appendFileSync(fixture.runner, '// changed\n')
    assert.throws(
      () => getExecutableForSpawn(command, { requireApproval: true }),
      /executable changed after approval/
    )
  })

  it('uses a clean environment with only explicitly required project variables', async () => {
    const previousSafe = process.env.DD_VALIDATION_PROJECT_MODE
    const previousSecret = process.env.CUSTOM_SECRET
    process.env.DD_VALIDATION_PROJECT_MODE = 'safe-value'
    process.env.CUSTOM_SECRET = 'must-not-leak'
    fs.writeFileSync(fixture.runner, [
      "console.log(process.env.DD_VALIDATION_PROJECT_MODE || 'missing')",
      "console.log(process.env.CUSTOM_SECRET || 'missing')",
    ].join('\n'))
    const command = {
      ...getBasicCommand(framework),
      requiredEnvVars: ['DD_VALIDATION_PROJECT_MODE'],
    }

    try {
      const result = await execute(command, 'environment')
      assert.match(result.stdout, /^safe-value\nmissing/m)
      assert.doesNotMatch(result.stdout, /must-not-leak/)
    } finally {
      restoreEnv('DD_VALIDATION_PROJECT_MODE', previousSafe)
      restoreEnv('CUSTOM_SECRET', previousSecret)
    }
  })

  it('does not execute when an approved required variable is unavailable', async () => {
    const command = {
      ...getBasicCommand(framework),
      requiredEnvVars: ['DD_VALIDATION_MISSING_INPUT'],
    }
    const result = await execute(command, 'missing-env')

    assert.strictEqual(result.exitCode, null)
    assert.deepStrictEqual(result.missingRequiredEnvVars, ['DD_VALIDATION_MISSING_INPUT'])
    assert.match(result.stderr, /requires environment variables/)
  })

  it('rejects command-local overrides of validator-controlled transport', async () => {
    const command = {
      ...getBasicCommand(framework),
      env: { DD_AGENT_HOST: 'attacker.example' },
    }
    const env = buildDatadogEnv({
      fixture: { manifestPath: path.join(fixture.root, 'offline.json') },
      framework,
      outputRoot: path.join(out, 'events'),
      scenario: 'basic-reporting',
    })

    await assert.rejects(
      runCommand(command, {
        artifactRoot: out,
        env,
        envMode: 'clean',
        outDir: path.join(out, 'env-override'),
        repositoryRoot: fixture.root,
      }),
      /must not override validator-controlled environment variable/
    )
  })

  it('bounds execution by time and preserves diagnostic artifacts', async function () {
    this.timeout(8000)
    fs.writeFileSync(fixture.runner, 'setInterval(() => {}, 1000)\n')
    const command = { ...getBasicCommand(framework), timeoutMs: 50 }
    const result = await execute(command, 'timeout')

    assert.strictEqual(result.timedOut, true)
    assert.ok(result.durationMs < 7000)
    assert.ok(fs.existsSync(result.artifacts.command))
    assert.ok(fs.existsSync(result.artifacts.stderr))
  })

  it('terminates the Windows process tree through the fixed system taskkill executable', async function () {
    this.timeout(8000)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    const systemRoot = process.env.SystemRoot
    const taskkill = 'C:\\Windows\\System32\\taskkill.exe'
    const calls = []
    fs.writeFileSync(fixture.runner, 'setInterval(() => {}, 1000)\n')

    try {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      process.env.SystemRoot = 'C:\\Windows'
      const windowsRunner = proxyquire('../../../../ci/test-optimization-validation/command-runner', {
        'node:fs': {
          lstatSync: filename => {
            if (filename === taskkill) {
              return { isFile: () => true, isSymbolicLink: () => false }
            }
            return fs.lstatSync(filename)
          },
          realpathSync: filename => filename === 'C:\\Windows' || filename === taskkill
            ? filename
            : fs.realpathSync(filename),
        },
        child_process: {
          spawn: childProcess.spawn,
          spawnSync: (filename, args) => {
            calls.push({ args, filename })
            try {
              process.kill(Number(args[1]), 'SIGKILL')
            } catch {}
            return { status: 0 }
          },
        },
      })
      const command = { ...getBasicCommand(framework), timeoutMs: 50 }
      const result = await windowsRunner.runCommand(command, {
        artifactRoot: out,
        outDir: path.join(out, 'windows-timeout'),
        repositoryRoot: fixture.root,
      })

      assert.strictEqual(result.timedOut, true)
      assert.ok(calls.length >= 1)
      assert.strictEqual(calls[0].filename, taskkill)
      assert.deepStrictEqual(calls[0].args.slice(0, 3), ['/PID', calls[0].args[1], '/T'])
      assert.ok(calls[0].args.includes('/F'))
    } finally {
      Object.defineProperty(process, 'platform', platform)
      restoreEnv('SystemRoot', systemRoot)
    }
  })

  it('bounds retained output while keeping the beginning and end', async () => {
    fs.writeFileSync(fixture.runner, "process.stdout.write('HEAD' + 'x'.repeat(5000) + 'TAIL')\n")
    const result = await execute({ ...getBasicCommand(framework), maxOutputBytes: 128 }, 'output')

    assert.strictEqual(result.stdoutTruncated, true)
    assert.match(result.stdout, /^HEAD/)
    assert.match(result.stdout, /bytes omitted/)
    assert.match(result.stdout, /TAIL$/)
  })

  it('refuses pre-existing outputs and removes newly created declared outputs', async () => {
    const outputPath = path.join(fixture.root, 'playwright-output')
    fs.writeFileSync(fixture.runner, [
      "const fs = require('node:fs')",
      'fs.mkdirSync(process.env.TEST_OUTPUT, { recursive: true })',
      "fs.writeFileSync(require('node:path').join(process.env.TEST_OUTPUT, 'result.txt'), 'ok')",
    ].join('\n'))
    const command = {
      ...getBasicCommand(framework),
      env: { TEST_OUTPUT: outputPath },
      outputPaths: [outputPath],
    }

    await execute(command, 'output-cleanup')
    assert.strictEqual(fs.existsSync(outputPath), false)

    fs.mkdirSync(outputPath)
    assert.throws(() => execute(command, 'output-preexisting'), /already exists/)
  })

  it('accepts a bounded direct-runner preflight when the output has no parseable count', async () => {
    fs.writeFileSync(fixture.runner, "console.log('selected test completed')\n")
    const result = await runFrameworkPreflight({
      framework,
      options: { repositoryRoot: fixture.root },
      out,
    })

    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.preflight.observedTestCount, null)
    assert.strictEqual(result.preflight.selectorVerification, 'bounded_direct_runner')
  })

  it('defers repository wrapper selector verification to instrumented test identity', async () => {
    framework.validation.selectorScope = 'instrumented_event_identity'
    fs.writeFileSync(fixture.runner, "console.log('selected test completed')\n")
    const result = await runFrameworkPreflight({
      framework,
      options: { repositoryRoot: fixture.root },
      out,
    })

    assert.strictEqual(result.ok, true)
    assert.strictEqual(
      result.preflight.selectorVerification,
      'requires_instrumented_event_identity'
    )
  })

  it('classifies a representative that the runner does not collect as project setup', async () => {
    fs.writeFileSync(fixture.runner, "console.error('No tests found')\nprocess.exit(1)\n")
    const result = await runFrameworkPreflight({
      framework,
      options: { repositoryRoot: fixture.root },
      out,
    })

    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.failure.evidence.domain, 'project_setup')
    assert.strictEqual(result.failure.evidence.commandFailure.kind, 'no-tests-collected')
    assert.match(result.failure.evidence.commandFailure.recommendation, /runtime test collectible/)
  })

  it('classifies a refused Cypress application connection as project setup', async () => {
    const cypressFixture = createRepositoryFixture({
      framework: 'cypress',
      runnerSource: [
        "console.error('CypressError: connect ECONNREFUSED 127.0.0.1:8080')",
        'process.exit(1)',
      ].join('\n'),
    })
    const cypressManifest = createLoadedManifest(cypressFixture.root, 'cypress')
    const cypressOut = path.join(cypressFixture.root, 'dd-test-optimization-validation-results')
    fs.mkdirSync(cypressOut, { recursive: true })
    try {
      const result = await runFrameworkPreflight({
        framework: cypressManifest.frameworks[0],
        options: { repositoryRoot: cypressFixture.root },
        out: cypressOut,
      })

      assert.strictEqual(result.ok, false)
      assert.strictEqual(result.failure.evidence.domain, 'project_setup')
      assert.strictEqual(result.failure.evidence.commandFailure.kind, 'cypress-application-unavailable')
      assert.match(result.failure.evidence.commandFailure.recommendation, /Start the application/)
    } finally {
      removeFixture(cypressFixture.root)
    }
  })

  it('accepts an exact generated test when the reporter omits the test count', async () => {
    fs.writeFileSync(fixture.runner, 'process.exit(0)\n')
    const result = await verifyGeneratedTestStrategy({
      framework,
      options: {
        repositoryRoot: fixture.root,
        scenarios: new Set(['efd']),
        verbose: false,
      },
      out,
    })

    assert.strictEqual(result.ok, true)
    assert.strictEqual(framework.generatedTestStrategy.status, 'verified')
    assert.strictEqual(
      framework.generatedTestStrategy.verification.observedScenarios[0].observedTestCount,
      null
    )
  })

  it('classifies a missing Playwright browser during generated verification as setup', async () => {
    framework.framework = 'playwright'
    framework.browserRequired = true
    fs.writeFileSync(fixture.runner, [
      "console.error(\"browserType.launch: Executable doesn't exist\")",
      "console.error('Please run the following command to download new browsers: playwright install')",
      'process.exit(1)',
      '',
    ].join('\n'))

    const result = await verifyGeneratedTestStrategy({
      framework,
      options: {
        repositoryRoot: fixture.root,
        scenarios: new Set(['efd']),
        verbose: false,
      },
      out,
    })

    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.failure.status, 'blocked')
    assert.strictEqual(result.failure.evidence.domain, 'project_setup')
    assert.strictEqual(result.failure.evidence.commandFailure.kind, 'playwright-browser-missing')
  })

  it('reports a timed-out preflight as incomplete rather than a tracer failure', async function () {
    this.timeout(8000)
    fs.writeFileSync(fixture.runner, 'setInterval(() => {}, 1000)\n')
    framework.validation.timeoutMs = 50
    const result = await runFrameworkPreflight({
      framework,
      options: { repositoryRoot: fixture.root },
      out,
    })

    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.failure.evidence.validationIncomplete, true)
    assert.match(result.failure.diagnosis, /could not be tested reliably/)
  })

  it('renders unambiguous approval commands and owns Test Optimization preloads', () => {
    const expectedCommand = process.platform === 'win32'
      ? '"/path with spaces/node" "a\'b" --flag'
      : '\'/path with spaces/node\' \'a\'"\'"\'b\' --flag'

    assert.strictEqual(
      serializeApprovalCommand({ argv: ['/path with spaces/node', 'a\'b', '--flag'] }),
      expectedCommand
    )
    assert.match(withCiPreloads('', framework).replaceAll('\\', '/'), /dd-trace-js\/ci\/init\.js/)
  })

  it('refuses command output cleanup when a parent is swapped and reuses a file reference above 2^53', () => {
    const { cleanupCommandOutputs, prepareCommandOutputs } =
      proxyquire('../../../../ci/test-optimization-validation/command-output-policy', {
        'node:fs': createWindowsFileReferenceFs(),
      })
    const outputParent = path.join(fixture.root, 'command-output')
    fs.mkdirSync(outputParent)
    const states = prepareCommandOutputs({
      artifactRoot: out,
      command: { cwd: fixture.root, outputPaths: [path.join(outputParent, 'result.json')] },
      repositoryRoot: fixture.root,
    })

    fs.renameSync(outputParent, `${outputParent}-original`)
    fs.mkdirSync(outputParent)

    assert.throws(() => cleanupCommandOutputs(states), /parent directory changed/)
  })

  it('refuses to publish a report when its parent is swapped and reuses a file reference above 2^53', () => {
    const parent = path.join(fixture.root, 'safe-write')
    fs.mkdirSync(parent)
    let swapped = false
    const { writeFileSafely } = proxyquire('../../../../ci/test-optimization-validation/safe-files', {
      'node:fs': createWindowsFileReferenceFs({
        openSync: (...args) => {
          const file = fs.openSync(...args)
          if (!swapped) {
            swapped = true
            fs.renameSync(parent, `${parent}-original`)
            fs.mkdirSync(parent)
          }
          return file
        },
      }),
    })

    assert.throws(
      () => writeFileSafely(fixture.root, path.join(parent, 'report.json'), '{}', 'validation report'),
      /parent directory changed during the write/
    )
    assert.strictEqual(swapped, true)
  })

  /**
   * Executes a direct command with standard test artifacts.
   *
   * @param {object} command command
   * @param {string} label artifact label
   * @returns {Promise<object>} command result
   */
  function execute (command, label) {
    return runCommand(command, {
      artifactRoot: out,
      envMode: 'clean',
      label,
      outDir: path.join(out, label),
      repositoryRoot: fixture.root,
    })
  }
})

/**
 * Restores an environment variable.
 *
 * @param {string} name environment name
 * @param {string|undefined} value previous value
 * @returns {void}
 */
function restoreEnv (name, value) {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}
