'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  getExecutableForSpawn,
  getResolvedExecutable,
  getUnavailableExecutable,
  isExplicitExecutablePath,
} = require('../../../../ci/test-optimization-validation/executable')
const { runCommand } = require('../../../../ci/test-optimization-validation/command-runner')
const {
  cleanupGeneratedFiles,
} = require('../../../../ci/test-optimization-validation/generated-files')
const {
  verifyGeneratedTestStrategy,
} = require('../../../../ci/test-optimization-validation/generated-verifier')
const {
  formatExecutionPlan,
} = require('../../../../ci/test-optimization-validation/plan-writer')
const {
  runFrameworkPreflight,
} = require('../../../../ci/test-optimization-validation/preflight-runner')
const {
  getObservedTestCount,
} = require('../../../../ci/test-optimization-validation/test-output')

describe('test optimization validator-owned execution phases', () => {
  it('runs a Datadog-clean preflight with local Jest adjustments', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-preflight-'))
    const jestEntrypoint = path.join(root, 'jest.js')
    fs.writeFileSync(
      jestEntrypoint,
      'if (process.env.NODE_OPTIONS || process.env.DD_API_KEY) process.exit(42); ' +
        'console.log("Tests: 1 passed, 1 total")\n'
    )
    const framework = {
      id: 'jest:root',
      framework: 'jest',
      existingTestCommand: {
        cwd: root,
        argv: [
          process.execPath,
          jestEntrypoint,
        ],
        env: {
          DD_API_KEY: 'must-not-reach-preflight',
          NODE_OPTIONS: '-r dd-trace/ci/init',
        },
      },
    }

    try {
      fs.mkdirSync(path.join(root, 'results'))
      const outcome = await runFrameworkPreflight({
        framework,
        options: { verbose: false },
        out: path.join(root, 'results'),
      })

      assert.strictEqual(outcome.ok, true)
      assert.strictEqual(framework.preflight.source, 'validator')
      assert.strictEqual(framework.preflight.exitCode, 0)
      assert.strictEqual(framework.preflight.observedTestCount, 1)
      assert.match(framework.preflight.command, /--no-watchman/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('verifies generated scenarios and removes retry state before advanced validation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-generated-'))
    const generatedDirectory = path.join(root, 'tests', 'dd-test-optimization-validation')
    const generatedFile = path.join(generatedDirectory, 'scenarios.test.js')
    const stateFile = path.join(generatedDirectory, '.dd-test-optimization-validation-atr-state')
    const framework = getPlannedFramework(root, generatedFile, stateFile)
    const out = path.join(root, 'results')

    try {
      fs.mkdirSync(out)
      const outcome = await verifyGeneratedTestStrategy({
        framework,
        options: { verbose: false },
        out,
      })

      assert.strictEqual(outcome.ok, true)
      assert.strictEqual(framework.generatedTestStrategy.status, 'verified')
      assert.deepStrictEqual(
        framework.generatedTestStrategy.verification.observedScenarios.map(scenario => scenario.observedTestCount),
        [1, 1, 1]
      )
      assert.strictEqual(fs.existsSync(stateFile), false)
      assert.strictEqual(fs.existsSync(generatedFile), true)

      cleanupGeneratedFiles({ frameworks: [framework] })

      assert.strictEqual(fs.existsSync(generatedFile), false)
      assert.strictEqual(fs.existsSync(generatedDirectory), false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('verifies only generated scenarios required by the selected advanced check', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-generated-'))
    const generatedFile = path.join(root, 'tests', 'dd-test-optimization-validation', 'scenarios.test.js')
    const stateFile = path.join(root, 'tests', '.dd-test-optimization-validation-atr-state')
    const framework = getPlannedFramework(root, generatedFile, stateFile)
    const out = path.join(root, 'results')

    try {
      fs.mkdirSync(out)
      const outcome = await verifyGeneratedTestStrategy({
        framework,
        options: {
          scenarios: new Set(['basic-reporting', 'efd']),
          verbose: false,
        },
        out,
      })

      assert.strictEqual(outcome.ok, true)
      assert.deepStrictEqual(
        framework.generatedTestStrategy.verification.observedScenarios.map(scenario => scenario.id),
        ['basic-pass']
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('prints normalized commands and unambiguous paths without executing project code', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-plan-'))
    const manifestPath = path.join(root, 'manifest.json')
    const generatedFile = path.join(root, 'tests', 'dd-test-optimization-validation.test.js')
    const framework = getPlannedFramework(root, generatedFile, path.join(root, '.dd-test-optimization-validation'))
    framework.project.name = '@example/app'
    framework.existingTestCommand = {
      cwd: root,
      argv: ['npm', 'test', '--', '--runInBand', '--token', 'plan-secret'],
      displayCommand: 'echo harmless-display-command',
      env: {
        BASH_ENV: './project-shell-init',
      },
      outputPaths: [path.join(root, 'coverage')],
    }
    framework.ciWiring = {
      status: 'unknown',
      reason: 'Replay selected.',
    }
    framework.ciWiringCommand = {
      cwd: root,
      usesShell: true,
      shellCommand: 'pnpm test',
      env: {
        CI: 'true',
        DD_API_KEY: 'safe-placeholder',
      },
    }
    framework.ciWiring.shell = 'bash --noprofile --norc {0}'
    const unsupportedFramework = {
      id: 'karma:browser-example',
      framework: 'karma',
      status: 'unsupported_by_validator',
      project: { name: 'browser-example', root: path.join(root, 'examples', 'browser') },
      notes: ['Karma requires browser execution and is not supported by this validator.'],
    }
    const manifest = {
      __path: manifestPath,
      repository: { root },
      frameworks: [framework, unsupportedFramework],
    }

    try {
      const plan = formatExecutionPlan({
        manifest,
        out: path.join(root, 'results'),
        selectedFrameworkIds: ['jest:root'],
        requestedScenario: 'atr',
      })
      const fullPlan = formatExecutionPlan({
        manifest,
        out: path.join(root, 'results'),
        selectedFrameworkIds: ['jest:root'],
      })
      const ciOnlyPlan = formatExecutionPlan({
        manifest,
        out: path.join(root, 'results'),
        selectedFrameworkIds: ['jest:root'],
        requestedScenario: 'ci-wiring',
      })

      assert.match(plan, /command above requires one approval before validation begins/)
      assert.doesNotMatch(plan, /Agent next action|command-approval dialog|approval surfaces/)
      assert.match(plan, /--no-watchman/)
      const relativeGeneratedFile = path.relative(root, generatedFile).split(path.sep).join('/')
      assert.match(plan, new RegExp(escapeRegExp(relativeGeneratedFile)))
      assert.doesNotMatch(plan, new RegExp(`Path: .*${escapeRegExp(generatedFile)}`))
      assert.match(plan, /npm test -- --runInBand --token <redacted> --no-watchman/)
      assert.doesNotMatch(plan, /echo harmless-display-command/)
      assert.match(plan, /BASH_ENV=\.\/project-shell-init/)
      assert.match(plan, /Command-created outputs: `coverage` \(must not exist before validation; newly created /)
      assert.match(fullPlan, /CI=true DD_API_KEY="<redacted>" bash --noprofile --norc -c "pnpm test"/)
      assert.match(plan, /NODE_OPTIONS="-r dd-trace\/ci\/init" npm test/)
      assert.match(ciOnlyPlan, /#### CI Test Execution/)
      assert.doesNotMatch(ciOnlyPlan, /#### Temporary Tests Created for Advanced Checks/)
      assert.match(plan, /#### Test Execution Without Datadog/)
      assert.match(plan, /#### Test Execution With Datadog/)
      assert.doesNotMatch(plan, /#### CI Test Execution/)
      assert.doesNotMatch(plan, /##### C\d|\| Check \| Command \|/)
      assert.match(plan, /#### Temporary Tests Created for Advanced Checks/)
      assert.match(plan, /Advanced Check: Auto Test Retries/)
      assert.doesNotMatch(plan, /Advanced Check: Early Flake Detection/)
      assert.doesNotMatch(plan, /Advanced Check: Test Management/)
      assert.doesNotMatch(plan, /#### Generated Test Verification:/)
      assert.match(fullPlan, /1, plus 1 short preload probe when needed/)
      assert.match(plan, /3: verify the test alone, discover its identity, then validate the feature/)
      assert.match(plan, /#### Temporary Test Cleanup/)
      assert.match(plan, /Paths are relative to the repository root/)
      assert.match(plan, /##### `tests\/dd-test-optimization-validation\.test\.js`/)
      assert.doesNotMatch(plan, /<details>|<summary>/)
      assert.match(plan, /\/\/ generated validation test/)
      assert.match(plan, /- Working directory: `\.`/)
      assert.match(plan, /## What Will Be Validated/)
      assert.match(plan, /\*\*Jest tests for @example\/app\*\*: will be validated/)
      assert.match(plan, /\*\*Karma tests for browser-example\*\*: not supported by this validator/)
      assert.match(plan, /## Executables Used/)
      assert.match(plan, /- Node\.js: `/)
      assert.match(fullPlan, /- Bash shell: `/)
      assert.doesNotMatch(plan, /Technical Safeguard: Command Identity|\(SHA-256 `/)
      assert.doesNotMatch(plan, /- Approved executable:|- Executable SHA-256:/)
      assert.strictEqual(countOccurrences(fullPlan, 'bash --noprofile --norc -c "pnpm test"'), 1)
      assert.match(plan, /## Start the Validation/)
      assert.match(plan, /local validator included with the installed `dd-trace` package/)
      assert.match(plan, /bounded filesystem cache fixtures/)
      assert.match(plan, /does not open a listener or use a network endpoint/)
      assert.match(plan, /During normal operation, `dd-trace` downloads Test Optimization settings/)
      assert.match(plan, /Private response directory:/)
      assert.match(plan, /Each check gets an isolated subdirectory containing bounded Test Optimization settings/)
      assert.doesNotMatch(plan, /\.testoptimization\/cache\/http\/settings\.json|Execution folders:/)
      assert.match(plan, /adds `DD_TRACE_DEBUG=1`/)
      assert.match(plan, /Exact fixture recipes and paths are included in the approval digest/)
      assert.doesNotMatch(plan, /Fixture recipe SHA-256/)
      assert.match(plan, /\.offline-payloads\/payloads\/tests/)
      assert.doesNotMatch(plan, /network listener|HTTP server/)
      assert.match(plan, /does not require real Datadog credentials, inspect credential stores, or upload/)
      assert.doesNotMatch(plan, /- Confirm the selected test command/)
      assert.doesNotMatch(plan, /Credential exposure: unknown/)
      assert.doesNotMatch(fullPlan, /safe-placeholder/)
      assert.doesNotMatch(plan, /plan-secret/)
      const planNonce = plan.match(/--offline-fixture-nonce ([a-f0-9]{32})/)?.[1]
      const fullPlanNonce = fullPlan.match(/--offline-fixture-nonce ([a-f0-9]{32})/)?.[1]
      assert.match(planNonce, /^[a-f0-9]{32}$/)
      assert.match(plan, new RegExp(`dd-test-optimization-validation-${planNonce}`))
      assert.notStrictEqual(planNonce, fullPlanNonce)
      assert.match(plan, /--approved-plan-sha256 [a-f0-9]{64} --framework jest:root --scenario atr/)
      const approvalDigest = plan.match(/--approved-plan-sha256 ([a-f0-9]{64})/)?.[1]
      assert.match(approvalDigest, /^[a-f0-9]{64}$/)
      assert.match(plan, /--print-approval-sha256 --framework jest:root --scenario atr/)
      assert.match(plan, new RegExp(`Expected output: \`${approvalDigest}\``))
      assert.match(plan, /validator generated the nonce and approval hash/)
      assert.match(plan, /regenerates the hash and stops if any covered input changed/)
      assert.match(plan, /without running project code/)
      assert.match(plan, /does not verify where that package came from/)
      assert.match(plan, /package-manager lockfile and integrity metadata/)
      assert.match(plan, /validate-test-optimization\.js --help/)
      assert.match(plan, /Run the approved validation command/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('renders commands separately when identical argv has different execution settings', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-command-shape-'))
    const packageRoot = path.join(root, 'package')
    const commandArgv = [process.execPath, '-e', 'console.log("Tests: 1 passed, 1 total")']
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'generated.test.js'),
      path.join(root, '.retry-state')
    )
    framework.existingTestCommand = {
      cwd: root,
      argv: commandArgv,
      env: { SAFE_MODE: 'direct' },
    }
    framework.ciWiring = { status: 'unknown', reason: 'Replay selected.' }
    framework.ciWiringCommand = {
      cwd: packageRoot,
      argv: commandArgv,
      env: { SAFE_MODE: 'ci' },
    }
    fs.mkdirSync(packageRoot)

    try {
      const plan = formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'results'),
        requestedScenario: 'ci-wiring',
      })
      const renderedCommand = 'node -e "console.log(\\"Tests: 1 passed, 1 total\\")"'

      assert.strictEqual(countOccurrences(plan, renderedCommand), 3)
      assert.match(plan, /SAFE_MODE=direct/)
      assert.match(plan, /SAFE_MODE=ci/)
      assert.match(plan, /Working directory: `package`/)
      assert.match(plan, /selected CI job supplies no Datadog variables/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses a short validator command for a standard node_modules installation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-short-plan-'))
    const directValidator = path.join(root, 'node_modules', 'dd-trace', 'ci', 'validate-test-optimization.js')
    const installedValidator = path.resolve(__dirname, '../../../../ci/validate-test-optimization.js')
    fs.mkdirSync(path.dirname(directValidator), { recursive: true })
    fs.symlinkSync(installedValidator, directValidator)

    try {
      const plan = formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'dd-test-optimization-validation-manifest.json'),
          repository: { root },
          frameworks: [],
        },
        out: path.join(root, 'dd-test-optimization-validation-results'),
      })

      assert.match(plan, /node node_modules\/dd-trace\/ci\/validate-test-optimization\.js/)
      assert.match(plan, /--approved-plan-sha256 [a-f0-9]{64}/)
      assert.doesNotMatch(plan, /--manifest|--out|\.pnpm/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects an approval plan whose structured command executable is unavailable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-unavailable-plan-'))
    const generatedFile = path.join(root, 'tests', 'dd-test-optimization-validation.test.js')
    const framework = getPlannedFramework(root, generatedFile, path.join(root, '.dd-validation-state'))
    framework.ciWiringCommand = {
      cwd: root,
      argv: ['definitely-not-an-installed-test-runner', 'test'],
    }

    try {
      assert.throws(() => formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'dd-test-optimization-validation-manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'dd-test-optimization-validation-results'),
      }), /Cannot render an approvable plan.*definitely-not-an-installed-test-runner.*not available/s)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves Windows executable names that already include a PATHEXT extension', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-windows-executable-'))
    const executable = path.join(root, 'npm.cmd')
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    fs.writeFileSync(executable, '')
    fs.chmodSync(executable, 0o755)

    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      const command = {
        cwd: root,
        argv: ['npm.cmd', 'test'],
        env: { PATH: root },
      }

      assert.strictEqual(getUnavailableExecutable(command), undefined)
      assert.strictEqual(getResolvedExecutable(command), executable)
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves relative PATH entries from the command working directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-relative-path-'))
    const bin = path.join(root, 'node_modules', '.bin')
    const executable = path.join(bin, 'test-runner')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(executable, '')
    fs.chmodSync(executable, 0o755)

    try {
      const command = {
        cwd: root,
        argv: ['test-runner'],
        env: { PATH: path.join('node_modules', '.bin') },
      }

      assert.strictEqual(getUnavailableExecutable(command), undefined)
      assert.strictEqual(getResolvedExecutable(command), executable)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('detects an executable replaced after approval before it can be spawned', async function () {
    if (process.platform === 'win32') this.skip()

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-executable-approval-'))
    const bin = path.join(root, 'bin')
    const executable = path.join(bin, 'test-runner')
    const marker = path.join(root, 'changed-executable-ran')
    const out = path.join(root, 'results')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.existingTestCommand = {
      cwd: root,
      argv: ['test-runner'],
      env: { PATH: bin },
    }
    const manifest = {
      __path: path.join(root, 'manifest.json'),
      repository: { root },
      frameworks: [framework],
    }
    fs.mkdirSync(bin)
    fs.mkdirSync(out)
    fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

    try {
      formatExecutionPlan({ manifest, out, requestedScenario: 'basic-reporting' })
      fs.writeFileSync(executable, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 })

      assert.throws(() => getExecutableForSpawn(framework.existingTestCommand), /changed after approval/)
      const result = await runCommand(
        framework.existingTestCommand,
        { artifactRoot: out, outDir: path.join(out, 'run'), repositoryRoot: root }
      )
      assert.match(result.stderr, /changed after approval/)
      assert.strictEqual(fs.existsSync(marker), false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('preserves approved named-shim semantics while executing the canonical target', async function () {
    if (process.platform === 'win32') this.skip()

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-named-shim-'))
    const bin = path.join(root, 'bin')
    const shim = path.join(bin, 'yarn')
    const marker = path.join(root, 'named-shim-ran')
    const out = path.join(root, 'results')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.existingTestCommand = {
      cwd: root,
      argv: [
        'yarn',
        '-e',
        'if (require(\'node:path\').basename(process.argv0) !== \'yarn\') process.exit(126); ' +
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'named-shim')`,
      ],
      env: { PATH: bin },
    }
    const manifest = {
      __path: path.join(root, 'manifest.json'),
      repository: { root },
      frameworks: [framework],
    }
    fs.mkdirSync(bin)
    fs.mkdirSync(out)
    fs.symlinkSync(process.execPath, shim)

    try {
      const plan = formatExecutionPlan({ manifest, out, requestedScenario: 'basic-reporting' })
      const result = await runCommand(
        framework.existingTestCommand,
        { artifactRoot: out, outDir: path.join(out, 'run'), repositoryRoot: root }
      )

      assert.strictEqual(result.exitCode, 0, result.stderr)
      assert.strictEqual(fs.existsSync(marker), true)
      assert.deepStrictEqual(getExecutableForSpawn(framework.existingTestCommand), {
        argv0: shim,
        path: fs.realpathSync(process.execPath),
      })
      assert.match(plan, new RegExp('Yarn: `' + escapeRegExp(shim) + '`.*verified target', 's'))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('preserves a Windows shim invocation path after verifying its canonical target', function () {
    if (process.platform === 'win32') this.skip()

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-windows-shim-'))
    const shim = path.join(root, 'test-runner.cmd')
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

    try {
      fs.symlinkSync(process.execPath, shim)
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

      assert.deepStrictEqual(getExecutableForSpawn({
        cwd: root,
        argv: [shim],
      }), {
        argv0: shim,
        path: shim,
      })
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves Windows forward-slash relative executable paths consistently for planning and execution', () => {
    assert.strictEqual(isExplicitExecutablePath('./node_modules/.bin/jest.cmd', 'win32'), true)
    assert.strictEqual(isExplicitExecutablePath('.\\node_modules\\.bin\\jest.cmd', 'win32'), true)
    assert.strictEqual(isExplicitExecutablePath('.\\node_modules\\.bin\\jest.cmd', 'linux'), false)

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-windows-relative-executable-'))
    const bin = path.join(root, 'node_modules', '.bin')
    const executable = path.join(bin, 'jest.cmd')
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.existingTestCommand = {
      cwd: root,
      argv: ['./node_modules/.bin/jest.cmd'],
    }
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(executable, '')
    fs.chmodSync(executable, 0o755)

    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'results'),
        requestedScenario: 'basic-reporting',
      })

      assert.strictEqual(getResolvedExecutable(framework.existingTestCommand), executable)
      assert.deepStrictEqual(getExecutableForSpawn(framework.existingTestCommand), {
        argv0: executable,
        path: executable,
      })
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects ambient Yarn when the repository pins a Yarn release', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-yarn-plan-'))
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.ciWiringCommand = { cwd: root, argv: ['yarn', 'test'] }
    fs.mkdirSync(path.join(root, '.yarn', 'releases'), { recursive: true })
    fs.writeFileSync(path.join(root, '.yarn', 'releases', 'yarn-4.4.1.cjs'), '')

    try {
      assert.throws(() => formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'dd-test-optimization-validation-manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'dd-test-optimization-validation-results'),
      }), /uses bare "yarn".*repository pins \.yarn\/releases\/yarn-4\.4\.1\.cjs/s)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects generated Vitest runtime tests under a typecheck-enabled config', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-vitest-plan-'))
    const generatedFile = path.join(root, 'tests', 'dd-test-optimization-validation.test.ts')
    const configFile = path.join(root, 'vitest.config.ts')
    const framework = getPlannedFramework(root, generatedFile, path.join(root, '.dd-validation-state'))
    framework.framework = 'vitest'
    framework.existingTestCommand.argv.push('--typecheck.enabled=false')
    framework.generatedTestStrategy.fileExtension = '.test.ts'
    fs.writeFileSync(configFile, 'export default { test: { typecheck: { enabled: true } } }\n')
    for (const scenario of framework.generatedTestStrategy.scenarios) {
      scenario.runCommand = {
        cwd: root,
        argv: [process.execPath, 'vitest.mjs', 'run', '--config', configFile, generatedFile],
      }
    }

    try {
      assert.throws(() => formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'dd-test-optimization-validation-manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'dd-test-optimization-validation-results'),
      }), /typecheck-enabled Vitest config.*count each generated test twice/s)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a selected Vitest command under a typecheck-enabled config', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-vitest-typecheck-plan-'))
    const configFile = path.join(root, 'vitest.config.ts')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'dd-test-optimization-validation.test.ts'),
      path.join(root, '.dd-validation-state')
    )
    framework.framework = 'vitest'
    framework.existingTestCommand = {
      cwd: root,
      argv: [process.execPath, '-e', '', '--config', configFile],
    }
    fs.writeFileSync(configFile, 'export default { test: { typecheck: { enabled: true } } }\n')

    try {
      assert.throws(() => formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'results'),
      }), /selected direct test command.*--typecheck\.enabled=false/s)

      framework.existingTestCommand.argv.push('--typecheck.enabled=false')
      for (const scenario of framework.generatedTestStrategy.scenarios) {
        scenario.runCommand.argv.push('--typecheck.enabled=false')
      }
      formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'results'),
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  for (const configName of ['vitest.config.ts', 'vite.config.ts']) {
    it(`rejects a selected Vitest command using default ${configName}`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-vitest-default-config-plan-'))
      const framework = getPlannedFramework(
        root,
        path.join(root, 'dd-test-optimization-validation.test.ts'),
        path.join(root, '.dd-validation-state')
      )
      framework.framework = 'vitest'
      framework.existingTestCommand = {
        cwd: root,
        argv: [process.execPath, '-e', ''],
      }
      fs.writeFileSync(
        path.join(root, configName),
        'export default { test: { typecheck: { enabled: true } } }\n'
      )

      try {
        assert.throws(() => formatExecutionPlan({
          manifest: {
            __path: path.join(root, 'manifest.json'),
            repository: { root },
            frameworks: [framework],
          },
          out: path.join(root, 'results'),
        }), new RegExp(`typecheck-enabled Vitest config .*${configName}`))
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it('rejects an unknown absolute Node shim for direct Vitest validation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-vitest-node-shim-'))
    const nodeShim = path.join(root, 'node')
    const framework = getPlannedFramework(
      root,
      path.join(root, 'dd-test-optimization-validation.test.ts'),
      path.join(root, '.dd-validation-state')
    )
    framework.framework = 'vitest'
    framework.existingTestCommand = {
      cwd: root,
      argv: [nodeShim, '-e', ''],
    }
    fs.writeFileSync(nodeShim, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

    try {
      assert.throws(() => formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'results'),
      }), /alternate Node executable.*Use "node".*process\.execPath/s)

      framework.existingTestCommand.argv[0] = process.execPath
      formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'results'),
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('requires setup-provided executables to exist before approval', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-setup-plan-'))
    const framework = getPlannedFramework(
      root,
      path.join(root, 'tests', 'dd-test-optimization-validation.test.js'),
      path.join(root, '.dd-validation-state')
    )
    framework.setup = {
      commands: [{
        id: 'install-test-runner',
        cwd: root,
        argv: [process.execPath, '-e', 'process.exit(0)'],
      }],
    }
    framework.existingTestCommand = {
      cwd: root,
      argv: ['test-runner-installed-by-setup', 'test'],
    }

    try {
      assert.throws(() => formatExecutionPlan({
        manifest: {
          __path: path.join(root, 'dd-test-optimization-validation-manifest.json'),
          repository: { root },
          frameworks: [framework],
        },
        out: path.join(root, 'dd-test-optimization-validation-results'),
        requestedScenario: 'basic-reporting',
      }), /test-runner-installed-by-setup.*not available/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('counts only Vitest tests executed through a name filter', () => {
    assert.strictEqual(getObservedTestCount('vitest', `
      Test Files  1 passed (1)
          Tests  1 passed | 2 skipped (3)
    `), 1)
    assert.strictEqual(getObservedTestCount('vitest', `
      Test Files  1 failed (1)
          Tests  1 failed | 2 skipped (3)
    `), 1)
    assert.strictEqual(getObservedTestCount('vitest', `
      Test Files  1 passed (1)
          Tests  3 passed (3)
    `), 3)
  })

  it('counts only Jest tests executed through a name filter', () => {
    assert.strictEqual(getObservedTestCount('jest', '', `
      Test Suites: 1 passed, 1 total
      Tests:       2 skipped, 1 passed, 3 total
    `), 1)
    assert.strictEqual(getObservedTestCount('jest', '', `
      Test Suites: 1 failed, 1 total
      Tests:       2 skipped, 1 failed, 3 total
    `), 1)
    assert.strictEqual(getObservedTestCount('jest', '', `
      Test Suites: 1 passed, 1 total
      Tests:       3 passed, 3 total
    `), 3)
  })

  it('counts Playwright test summaries', () => {
    assert.strictEqual(getObservedTestCount('playwright', `
      Running 1 test using 1 worker
      1 passed (1.2s)
    `), 1)
    assert.strictEqual(getObservedTestCount('playwright', `
      1 failed
      1 passed (2.3s)
    `), 2)
    assert.strictEqual(getObservedTestCount('playwright', '1 skipped'), 0)
  })
})

function getPlannedFramework (root, generatedFile, stateFile) {
  return {
    id: 'jest:root',
    framework: 'jest',
    status: 'runnable',
    project: { root },
    existingTestCommand: {
      cwd: root,
      argv: [process.execPath, '-e', 'console.log("Tests: 1 passed, 1 total")'],
    },
    generatedTestStrategy: {
      status: 'planned',
      files: [{
        path: generatedFile,
        contentLines: ['// generated validation test'],
      }],
      scenarios: [
        getScenario(root, 'basic-pass', 0),
        getScenario(root, 'atr-fail-once', 1, stateFile),
        getScenario(root, 'test-management-target', 0),
      ],
      cleanupPaths: [generatedFile, stateFile],
    },
  }
}

function getScenario (root, id, exitCode, stateFile) {
  const script = stateFile
    ? `require('node:fs').writeFileSync(${JSON.stringify(stateFile)}, 'state'); ` +
      'console.log("Tests: 1 failed, 1 total"); process.exit(1)'
    : `console.log("Tests: 1 passed, 1 total"); process.exit(${exitCode})`
  return {
    id,
    runCommand: {
      cwd: root,
      argv: [process.execPath, '-e', script],
    },
    expectedWithoutDatadog: {
      exitCode,
      observedTestCount: 1,
    },
    testIdentities: [{ name: id, file: path.join(root, `${id}.test.js`) }],
  }
}

function escapeRegExp (value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

function countOccurrences (value, search) {
  return value.split(search).length - 1
}
