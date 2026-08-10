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
const { getCommandBlocker } = require('../../../../ci/test-optimization-validation/command-blocker')
const {
  bindManifestExecutables,
  getExecutableForSpawn,
} = require('../../../../ci/test-optimization-validation/executable')
const {
  verifyGeneratedTestStrategy,
} = require('../../../../ci/test-optimization-validation/generated-verifier')
const { runFrameworkPreflight } = require('../../../../ci/test-optimization-validation/preflight-runner')
const { getBasicCommand } = require('../../../../ci/test-optimization-validation/runner-command')
const { getObservedTestCount } = require('../../../../ci/test-optimization-validation/test-output')
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

  it('classifies a concrete missing build output without executing the build script', () => {
    const packageJsonPath = path.join(fixture.root, 'package.json')
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath))
    packageJson.scripts.build = 'node ./scripts/build.js'
    fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson)}\n`)

    const blocker = getCommandBlocker({
      exitCode: 1,
      stderr: "Error: Cannot find module './dist/generated/schema.js'",
      stdout: '',
    }, {
      framework: 'mocha',
      packageJson: packageJsonPath,
      testsRan: false,
    })

    assert.strictEqual(blocker.kind, 'project-build-artifact-missing')
    assert.strictEqual(blocker.blockerCategory, 'PROJECT_SETUP_REQUIRED')
    assert.match(blocker.recommendation, /"build": "node \.\/scripts\/build\.js"/)
    assert.match(blocker.summary, /does not run project build commands/)
  })

  it('classifies a missing dist artifact from a Cypress setup hook after tests were collected', () => {
    const blocker = getCommandBlocker({
      exitCode: 1,
      stderr: '',
      stdout: [
        'Tests: 274',
        '1) "before all" hook for "should restore focus"',
        `Error: ${path.join(fixture.root, 'dist', 'sweetalert2.css')} is not found`,
      ].join('\n'),
    }, {
      framework: 'cypress',
      packageJson: path.join(fixture.root, 'package.json'),
      testsRan: true,
    })

    assert.strictEqual(blocker.kind, 'project-build-artifact-missing')
    assert.strictEqual(blocker.blockerCategory, 'PROJECT_SETUP_REQUIRED')
  })

  it('does not diagnose dependency dist paths as missing project build output', () => {
    for (const stderr of [
      "Error: Cannot find module '@scope/dependency/dist/index.js'",
      `Error: Cannot find module '${path.join(fixture.root, 'node_modules', 'dependency', 'dist', 'index.js')}'`,
      "Error: Cannot find module '/opt/vendor/dist/index.js'",
      "Error: Cannot find module '/build/index.js'",
      "Error: Cannot find module '/dist/index.js'",
      "Error: Cannot find module '/generated/index.js'",
      "Error: Cannot find module '../vendor/dist/index.js'",
    ]) {
      const blocker = getCommandBlocker({ exitCode: 1, stderr, stdout: '' }, {
        framework: 'mocha',
        packageJson: path.join(fixture.root, 'package.json'),
        testsRan: false,
      })

      assert.strictEqual(blocker.kind, 'project-command-initialization-failed', stderr)
      assert.doesNotMatch(blocker.recommendation, /project's normal build workflow/)
    }
  })

  it('classifies a validator-owned Cucumber config rejection as a validator limitation', () => {
    const blocker = getCommandBlocker({
      exitCode: 1,
      stderr: "error: unknown option '--config'",
      stdout: '',
    }, {
      framework: 'cucumber',
      testsRan: false,
    })

    assert.strictEqual(blocker.kind, 'cucumber-config-isolation-unsupported')
    assert.strictEqual(blocker.blockerCategory, 'VALIDATOR_LIMITATION')
    assert.match(blocker.summary, /not a project test or Test Optimization failure/)
  })

  it('classifies a permission-denied Puppeteer launch as an execution environment blocker', () => {
    const blocker = getCommandBlocker({
      exitCode: 1,
      stderr: [
        'Error: Failed to launch the browser process!',
        'spawn /project/chrome EACCES',
        'Permission denied',
      ].join('\n'),
      stdout: '',
    }, {
      browserRequired: true,
      framework: 'cucumber',
      testsRan: false,
    })

    assert.strictEqual(blocker.kind, 'cucumber-browser-launch-blocked')
    assert.strictEqual(blocker.blockerCategory, 'EXECUTION_ENVIRONMENT_BLOCKED')
    assert.match(blocker.recommendation, /same approved plan/)
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
    assert.throws(
      () => execute(command, 'output-preexisting'),
      error => {
        assert.strictEqual(error.validationExitCode, 2)
        assert.strictEqual(error.validationBlocker.kind, 'command-output-exists')
        assert.match(error.validationBlocker.recommendation, /Remove it manually only if it is disposable/)
        return true
      }
    )
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

  it('classifies a representative that the runner does not collect as a validator limitation', async () => {
    fs.writeFileSync(fixture.runner, "console.error('No tests found')\nprocess.exit(1)\n")
    const result = await runFrameworkPreflight({
      framework,
      options: { repositoryRoot: fixture.root },
      out,
    })

    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.failure.evidence.blockerCategory, 'VALIDATOR_LIMITATION')
    assert.strictEqual(result.failure.evidence.domain, 'validator_adapter')
    assert.strictEqual(result.failure.evidence.commandFailure.kind, 'no-tests-collected')
    assert.match(result.failure.evidence.commandFailure.recommendation, /runtime test collectible/)
  })

  it('tries only disclosed fallbacks and selects the first clean candidate', async () => {
    const first = path.join(fixture.root, 'test', 'a-first.spec.js')
    const second = path.join(fixture.root, 'test', 'b-second.spec.js')
    fs.writeFileSync(first, "describe('first', () => { it('works', () => {}) })\n")
    fs.writeFileSync(second, "describe('second', () => { it('works', () => {}) })\n")
    fs.writeFileSync(fixture.runner, [
      "if (process.argv.at(-1).includes('a-first')) {",
      "  console.error('Error: missing generated build output')",
      '  process.exit(1)',
      '}',
      "console.log('1 passing')",
    ].join('\n'))
    const packageJsonPath = path.join(fixture.root, 'package.json')
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath))
    packageJson.scripts.test = 'mocha'
    fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson)}\n`)
    manifest = createLoadedManifest(fixture.root, 'mocha')
    framework = manifest.frameworks[0]

    const result = await runFrameworkPreflight({
      framework,
      options: { repositoryRoot: fixture.root },
      out,
    })

    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.preflight.attempts.length, 2)
    assert.strictEqual(result.preflight.attempts[0].testFile, first)
    assert.strictEqual(result.preflight.selectedTestFile, second)
    assert.strictEqual(framework.validation.testFile, second)
  })

  it('tries a self-contained fallback after a candidate-specific localhost denial', async () => {
    const first = path.join(fixture.root, 'test', 'a-socket.spec.js')
    const second = path.join(fixture.root, 'test', 'b-plain.spec.js')
    fs.writeFileSync(first, "describe('socket', () => { it('works', () => {}) })\n")
    fs.writeFileSync(second, "describe('plain', () => { it('works', () => {}) })\n")
    fs.writeFileSync(fixture.runner, [
      "if (process.argv.at(-1).includes('a-socket')) {",
      "  console.error('listen EPERM 127.0.0.1')",
      '  process.exit(1)',
      '}',
      "console.log('1 passing')",
    ].join('\n'))
    framework.validation.testFile = first
    framework.validation.fallbackTests = [{
      buildArtifactRequired: false,
      localSocketRequired: false,
      testFile: second,
    }]
    framework.allCandidatesRequireLocalSocket = false

    const result = await runFrameworkPreflight({
      framework,
      options: { repositoryRoot: fixture.root },
      out,
    })

    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.preflight.attempts.length, 2)
    assert.strictEqual(result.preflight.selectedTestFile, second)
  })

  it('stops disclosed fallbacks after an execution-environment browser blocker', async () => {
    const first = path.join(fixture.root, 'test', 'a-first.spec.js')
    const second = path.join(fixture.root, 'test', 'b-second.spec.js')
    fs.writeFileSync(first, "describe('first', () => { it('works', () => {}) })\n")
    fs.writeFileSync(second, "describe('second', () => { it('works', () => {}) })\n")
    fs.writeFileSync(fixture.runner, [
      "console.error('browserType.launch: Failed to launch the browser process')",
      "console.error('Operation not permitted: bootstrap_check_in')",
      'process.exit(1)',
    ].join('\n'))
    const packageJsonPath = path.join(fixture.root, 'package.json')
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath))
    packageJson.scripts.test = 'mocha'
    fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson)}\n`)
    manifest = createLoadedManifest(fixture.root, 'mocha')
    framework = manifest.frameworks[0]
    framework.framework = 'playwright'
    framework.browserRequired = true
    framework.allCandidatesRequireLocalSocket = true

    const result = await runFrameworkPreflight({
      framework,
      options: { repositoryRoot: fixture.root },
      out,
    })

    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.preflight.attempts.length, 1)
    assert.strictEqual(result.failure.evidence.domain, 'execution_environment')
    assert.strictEqual(
      result.failure.evidence.commandFailure.kind,
      'playwright-browser-launch-blocked'
    )
    assert.doesNotMatch(result.failure.diagnosis, /Every approved candidate appears to require localhost/)
  })

  it('stops disclosed Cucumber fallbacks when the shared browser is missing', async () => {
    const fallback = path.join(fixture.root, 'test', 'fallback.feature')
    fs.writeFileSync(fallback, 'Feature: fallback\n\n  Scenario: fallback\n    Given it works\n')
    fs.writeFileSync(fixture.runner, [
      "console.error('Error: Could not find Chrome (ver. 127.0.0.0)')",
      'process.exit(1)',
    ].join('\n'))
    framework.framework = 'cucumber'
    framework.browserRequired = true
    framework.validation.fallbackTests = [{
      buildArtifactRequired: false,
      localSocketRequired: false,
      testFile: fallback,
    }]

    const result = await runFrameworkPreflight({
      framework,
      options: { repositoryRoot: fixture.root },
      out,
    })

    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.preflight.attempts.length, 1)
    assert.strictEqual(result.failure.evidence.commandFailure.kind, 'cucumber-browser-missing')
  })

  for (const [description, stream, output, expected] of [
    ['concrete project failure', 'error', 'Error: missing generated build output', /missing generated build output/],
    [
      'TypeError from project output',
      'log',
      "TypeError: Cannot read properties of null (reading 'port')",
      /Cannot read properties of null/,
    ],
  ]) {
    it(`includes the ${description} when every disclosed candidate fails`, async () => {
      fs.writeFileSync(fixture.runner, `console.${stream}(${JSON.stringify(output)})\nprocess.exit(1)\n`)
      const result = await runFrameworkPreflight({
        framework,
        options: { repositoryRoot: fixture.root },
        out,
      })

      assert.strictEqual(result.ok, false)
      assert.match(result.failure.diagnosis, expected)
      assert.match(result.failure.evidence.recommendation, expected)
    })
  }

  it('explains when every disclosed candidate shares a localhost prerequisite', async () => {
    fs.writeFileSync(fixture.runner, [
      "console.log(\"TypeError: Cannot read properties of null (reading 'port')\")",
      'process.exit(1)',
    ].join('\n'))
    framework.allCandidatesRequireLocalSocket = true

    const result = await runFrameworkPreflight({
      framework,
      options: { repositoryRoot: fixture.root },
      out,
    })

    assert.strictEqual(result.ok, false)
    assert.match(result.failure.diagnosis, /Every approved candidate appears to require localhost/)
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

  it('classifies an aborted Cucumber browser as a local runtime blocker', async () => {
    fs.writeFileSync(fixture.runner, [
      "console.error('Error: Failed to launch the browser process!')",
      "console.error('Received signal 6')",
      'process.exit(1)',
    ].join('\n'))
    framework.framework = 'cucumber'
    framework.browserRequired = true

    const result = await runFrameworkPreflight({
      framework,
      options: { repositoryRoot: fixture.root },
      out,
    })

    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.failure.evidence.domain, 'local_runtime')
    assert.strictEqual(result.failure.evidence.commandFailure.kind, 'cucumber-browser-process-aborted')
    assert.match(result.failure.evidence.commandFailure.recommendation, /Cucumber browser tests can launch/)
  })

  for (const [description, browserFailure, expectedKind] of [
    ['keeps a Cucumber formatter exception unclassified without', '', undefined],
    [
      'classifies a Cucumber formatter exception only with',
      'Browser session closed before formatter completion\n',
      'cucumber-browser-execution-incomplete',
    ],
  ]) {
    it(`${description} browser failure evidence`, async () => {
      const output = `${browserFailure}TypeError: Cannot read properties of undefined (reading 'line')`
      fs.writeFileSync(fixture.runner, `console.error(${JSON.stringify(output)})\nprocess.exit(1)\n`)
      framework.framework = 'cucumber'
      framework.browserRequired = true

      const result = await runFrameworkPreflight({
        framework,
        options: { repositoryRoot: fixture.root },
        out,
      })

      assert.strictEqual(result.ok, false)
      assert.strictEqual(result.failure.evidence.domain, 'local_runtime')
      assert.strictEqual(result.failure.evidence.commandFailure?.kind, expectedKind)
      if (!expectedKind) {
        assert.strictEqual(result.failure.evidence.blockerCategory, 'CLEAN_TEST_FAILED')
        assert.strictEqual(result.failure.evidence.commandFailure, undefined)
        assert.match(result.failure.diagnosis, /Cannot read properties of undefined/)
      }
    })
  }

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
    assert.match(withCiPreloads('', framework).replaceAll('\\', '/'), /-r "?[^"]*\/ci\/init\.js"?$/)
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
        // Windows refuses to rename a directory that still holds an open handle, so the swap waits
        // until the temporary file is closed.
        closeSync: (file) => {
          fs.closeSync(file)
          if (!swapped) {
            swapped = true
            fs.renameSync(parent, `${parent}-original`)
            fs.mkdirSync(parent)
          }
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

describe('test optimization validation observed test counts', () => {
  it('reads playwright summaries per line and treats a skipped-only run as zero', () => {
    const summary = ['Running 3 tests using 1 worker', '', '  2 passed (1.2s)', '  1 flaky (0.4s)'].join('\n')

    assert.strictEqual(getObservedTestCount('playwright', summary), 3)
    assert.strictEqual(getObservedTestCount('playwright', '  4 skipped (0.1s)'), 0)
    assert.strictEqual(getObservedTestCount('playwright', 'no summary here'), null)
  })

  it('does not join a count and its outcome across a line break', () => {
    assert.strictEqual(getObservedTestCount('playwright', '2\npassed'), null)
    assert.strictEqual(getObservedTestCount('playwright', '2\nskipped'), null)
  })
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
