'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { getArtifactId } = require('../../../../ci/test-optimization-validation/artifact-id')
const {
  getCiRuntimeCompatibility,
} = require('../../../../ci/test-optimization-validation/ci-runtime-compatibility')
const { runCiWiring } = require('../../../../ci/test-optimization-validation/scenarios/ci-wiring')

function validationOptions (repositoryRoot) {
  return {
    approvedPlanSha256: '0'.repeat(64),
    offlineFixtureNonce: '0'.repeat(32),
    repositoryRoot,
    verbose: false,
  }
}

describe('test optimization CI wiring validation', () => {
  it('reports an entirely unsupported CI Node matrix as a compatibility blocker', async () => {
    const framework = {
      id: 'mocha:root',
      framework: 'mocha',
      project: { name: 'fixture' },
      ciWiring: {
        status: 'unknown',
        replayability: 'replayable',
        matrix: { 'node-version': ['12.20.0', '14.13.1', '16.0.0'] },
      },
      ciWiringCommand: {
        cwd: process.cwd(),
        argv: [process.execPath, '-e', 'throw new Error("must not run")'],
      },
    }

    const result = await runCiWiring({ manifest: {}, framework })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.validationIncomplete, true)
    assert.strictEqual(result.evidence.runtimeCompatibility.status, 'incompatible')
    assert.deepStrictEqual(result.evidence.runtimeCompatibility.unsupportedNodeVersions, [
      '12.20.0',
      '14.13.1',
      '16.0.0',
    ])
    assert.match(result.diagnosis, /every recorded CI Node\.js version/)
    assert.match(result.evidence.recommendation, /Select or upgrade a CI matrix entry/)
  })

  it('identifies a supported entry in a mixed CI Node matrix', () => {
    const currentNodeMajor = process.versions.node.split('.')[0]
    const compatibility = getCiRuntimeCompatibility({
      ciWiring: {
        matrix: {
          node: ['16', `${currentNodeMajor}.0.0`],
        },
      },
    })

    assert.strictEqual(compatibility.status, 'mixed')
    assert.deepStrictEqual(compatibility.supportedNodeVersions, [`${currentNodeMajor}.0.0`])
    assert.deepStrictEqual(compatibility.unsupportedNodeVersions, ['16'])
  })

  it('reports a static CI wiring classification as incomplete when its command is missing', async () => {
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

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.manifestIncomplete, true)
    assert.match(result.diagnosis, /CI wiring was not replayed/)
    assert.match(result.diagnosis, /CI does not configure Datadog initialization/)
  })

  it('does not return a conclusive failure from static evidence when the CI command cannot be replayed', async () => {
    const result = await runCiWiring({
      manifest: {},
      framework: {
        id: 'vitest:date-fns',
        framework: 'vitest',
        project: { name: 'date-fns' },
        ciWiring: {
          status: 'skip',
          provider: 'github-actions',
          diagnosis: 'The CI command requires mise, which is unavailable locally.',
          initialization: {
            status: 'not_configured',
            evidence: ['The selected CI job does not set NODE_OPTIONS or Datadog environment variables.'],
          },
        },
      },
      basicResult: {
        status: 'pass',
        diagnosis: 'Basic Reporting passed.',
      },
    })

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.manifestIncomplete, true)
    assert.match(result.diagnosis, /CI wiring was not replayed/)
    assert.match(result.diagnosis, /requires mise/)
    assert.match(result.diagnosis, /No live CI-wiring conclusion was reached/)
    assert.strictEqual(result.evidence.eventLevelFailure, undefined)
    assert.deepStrictEqual(result.evidence.ciRemediation.variants.map(variant => variant.id), ['agentless'])
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
    assert.match(result.diagnosis, /CI wiring was not replayed/)
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
        out,
        options: validationOptions(out),
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
      assert.deepStrictEqual(result.evidence.directInitializationBasicReporting, {
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

  it('uses the live replay diagnosis and recommends an existing Datadog test script', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
    fs.writeFileSync(path.join(out, 'package.json'), `${JSON.stringify({
      scripts: {
        test: 'jest',
        'test:datadog': "NODE_OPTIONS='-r dd-trace/ci/init' npm test",
      },
    })}\n`)

    try {
      const result = await runCiWiring({
        manifest: { repository: { root: out } },
        framework: {
          id: 'jest:root',
          framework: 'jest',
          project: { root: out },
          ciWiring: {
            diagnosis: 'The CI step runs test instead of the existing test:datadog script.',
          },
          ciWiringCommand: {
            cwd: out,
            argv: [process.execPath, '-e', 'console.log("1 passing")'],
          },
        },
        out,
        options: validationOptions(out),
        basicResult: {
          status: 'pass',
          diagnosis: 'Basic Reporting passed.',
        },
      })

      assert.strictEqual(result.status, 'fail')
      assert.match(result.diagnosis, /test command used by the CI job was identified and ran tests/)
      assert.doesNotMatch(result.diagnosis, /CI step runs test instead of the existing test:datadog script/)
      assert.deepStrictEqual(result.evidence.existingDatadogInitScripts, [{
        name: 'test:datadog',
        packageJson: path.join(out, 'package.json'),
      }])
      assert.match(result.evidence.eventLevelFailure.recommendation, /already defines `test:datadog`/)
      assert.match(result.evidence.eventLevelFailure.recommendation, /identified CI test step to invoke that script/)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('diagnoses dd-trace initialization from a Vitest setup file as too late', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
    const setupFile = path.join(out, 'datadog-setup.ts')
    const configFile = path.join(out, 'vitest.config.ts')
    fs.writeFileSync(setupFile, 'import "dd-trace/ci/init"\n')
    fs.writeFileSync(configFile, 'export default { test: { setupFiles: ["datadog-setup.ts"] } }\n')

    try {
      const result = await runCiWiring({
        manifest: { repository: { root: out } },
        framework: {
          id: 'vitest:root',
          framework: 'vitest',
          project: { root: out, configFiles: [configFile] },
          ciWiringCommand: {
            cwd: out,
            argv: [process.execPath, '-e', 'console.log("Tests 1 passed")'],
          },
        },
        out,
        options: validationOptions(out),
        basicResult: { status: 'pass', diagnosis: 'Basic Reporting passed.' },
      })

      assert.strictEqual(result.status, 'fail')
      assert.deepStrictEqual(result.evidence.lateInitialization, [{ configFile, setupFile }])
      assert.match(result.diagnosis, /setup files after the runner starts.*too late/s)
      assert.match(result.evidence.eventLevelFailure.recommendation, /Move Test Optimization initialization out/)
      assert.match(result.evidence.eventLevelFailure.recommendation, /NODE_OPTIONS=-r dd-trace\/ci\/init/)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('diagnoses a package script that explicitly removes NODE_OPTIONS', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
    try {
      const packageJson = path.join(out, 'package.json')
      fs.writeFileSync(packageJson, `${JSON.stringify({
        scripts: {
          'test:ci': 'NODE_OPTIONS= yarn workspace app test',
        },
      }, null, 2)}\n`)
      const result = await runCiWiring({
        manifest: { repository: { root: out } },
        framework: {
          id: 'vitest:root',
          framework: 'vitest',
          ciWiring: {
            packageScriptExpansionChain: [
              'yarn test:ci',
              'NODE_OPTIONS= yarn workspace app test',
              'vitest run',
            ],
          },
          ciWiringCommand: {
            cwd: out,
            argv: [process.execPath, '-e', 'console.log("Tests 1 passed")'],
          },
        },
        out,
        options: validationOptions(out),
        basicResult: { status: 'pass', diagnosis: 'Basic Reporting passed.' },
      })

      assert.strictEqual(result.status, 'fail')
      assert.deepStrictEqual(result.evidence.nodeOptionsRemoval, {
        command: 'NODE_OPTIONS= yarn workspace app test',
        packageJson,
        scriptName: 'test:ci',
      })
      assert.match(result.diagnosis, /script `test:ci` in .*package\.json.*empty `NODE_OPTIONS=` assignment/s)
      assert.match(result.diagnosis, /same Vitest test command.*reports test data successfully/s)
      assert.match(result.evidence.eventLevelFailure.recommendation,
        /Script `test:ci` in .*package\.json.*clears NODE_OPTIONS/s)
      assert.match(result.evidence.eventLevelFailure.recommendation, /pass the CI-provided/)
      assert.doesNotMatch(result.evidence.eventLevelFailure.recommendation, /Compare the passing/)
      assert.deepStrictEqual(result.evidence.monorepoFindings, [])
      assert.strictEqual(result.evidence.initializationProbe.ran, false)
      assert.strictEqual(result.evidence.initializationProbe.skippedBecauseConfigurationProvesRemoval, true)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('replays shell CI commands with the recorded CI shell', async function () {
    if (process.platform === 'win32') this.skip()

    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
    const marker = path.join(out, 'ci-shell-used')
    const shell = path.join(out, 'ci-shell')
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
        out,
        options: validationOptions(out),
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
        out,
        options: validationOptions(out),
      })

      assert.strictEqual(result.status, 'error')
      assert.strictEqual(result.evidence.commandExitCode, 1)
      assert.strictEqual(result.evidence.validationIncomplete, true)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('preserves recorded CI shell failure flags without template placeholders', async function () {
    if (process.platform === 'win32') this.skip()

    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
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
        out,
        options: validationOptions(out),
      })

      assert.strictEqual(result.status, 'error')
      assert.strictEqual(result.evidence.commandExitCode, 1)
      assert.strictEqual(result.evidence.validationIncomplete, true)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('redacts secret-like event data in CI wiring events artifacts', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))

    try {
      await runCiWiring({
        framework: {
          id: 'vitest:root',
          framework: 'vitest',
          ciWiringCommand: {
            cwd: out,
            argv: [process.execPath, '-e', offlineEventScript([{
              type: 'test',
              meta: {
                API_KEY: 'ci-wiring-event-api-key-secret',
                command: 'TOKEN=ci-wiring-event-token-secret npm test',
                message: 'SECRET=ci-wiring-event-secret',
              },
            }])],
          },
        },
        out,
        options: validationOptions(out),
      })

      const eventsArtifact = path.join(out, 'runs', getArtifactId('vitest:root'), 'ci-wiring', 'events.ndjson')
      const events = fs.readFileSync(eventsArtifact, 'utf8')
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
        out,
        options: validationOptions(out),
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

  it('aggregates repeated test runner probe signals by tool and working directory', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
    const wrapperScript = path.join(out, 'run-tests.js')
    const vitestScript = path.join(out, 'vitest.mjs')
    fs.writeFileSync(vitestScript, 'console.log("Tests 1 passed")\n')
    fs.writeFileSync(wrapperScript, `
      const { spawnSync } = require('node:child_process')
      for (let index = 0; index < 2; index++) {
        spawnSync(process.execPath, [${JSON.stringify(vitestScript)}], { stdio: 'inherit' })
      }
    `)

    try {
      const result = await runCiWiring({
        framework: {
          id: 'vitest:root',
          framework: 'vitest',
          ciWiringCommand: {
            cwd: out,
            argv: [process.execPath, wrapperScript],
          },
        },
        out,
        options: validationOptions(out),
        basicResult: { status: 'pass', diagnosis: 'Basic Reporting passed.' },
      })

      assert.strictEqual(result.status, 'fail')
      assert.strictEqual(result.evidence.initializationProbe.reachedTestRunnerProcess, true)
      assert.strictEqual(result.evidence.initializationProbe.testRunnerSignals.length, 1)
      assert.strictEqual(result.evidence.initializationProbe.testRunnerSignals[0].name, 'vitest')
      assert.strictEqual(result.evidence.initializationProbe.testRunnerSignals[0].cwd, fs.realpathSync(out))
      assert.strictEqual(result.evidence.initializationProbe.testRunnerSignals[0].processCount, 1)
      assert.strictEqual(result.evidence.initializationProbe.stoppedAfterRunnerReached, true)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('lets live replay override an incorrect static not-configured claim', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))

    try {
      const result = await runCiWiring({
        manifest: { repository: { root: out } },
        framework: {
          id: 'vitest:root',
          framework: 'vitest',
          project: { root: out },
          ciWiring: {
            status: 'unknown',
            provider: 'github-actions',
            configFile: path.join(out, '.github/workflows/test.yml'),
            workflow: 'test',
            job: 'unit',
            step: 'Run tests',
            initialization: {
              status: 'not_configured',
              evidence: ['The unit job defines no NODE_OPTIONS or Datadog environment variables.'],
            },
          },
          ciWiringCommand: {
            cwd: out,
            argv: [process.execPath, '-e', offlineEventScript([
              { type: 'test_session_end' },
              { type: 'test_module_end' },
              { type: 'test_suite_end' },
              { type: 'test' },
            ])],
            env: {
              NODE_OPTIONS: `-r ${path.resolve('ci/init.js')}`,
            },
          },
        },
        out,
        options: validationOptions(out),
        basicResult: { status: 'pass', diagnosis: 'Basic Reporting passed.' },
      })

      assert.strictEqual(result.status, 'pass', JSON.stringify(result))
      assert.deepStrictEqual(result.evidence.ciCommandExecution, {
        mode: 'full-replay',
        fullReplayRan: true,
      })
      assert.strictEqual(result.evidence.commandExitCode, 0)
      assert.match(result.diagnosis, /CI test command emitted session, module, suite, and test events/)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('completes a large CI replay and reaches a conclusive result from bounded sampled evidence', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-large-ci-wiring-'))

    try {
      const result = await runCiWiring({
        manifest: { repository: { root: out } },
        framework: {
          id: 'vitest:large-ci-job',
          framework: 'vitest',
          project: { root: out },
          ciWiring: { status: 'unknown', reason: 'The CI command is replayable.' },
          ciWiringCommand: {
            cwd: out,
            argv: [process.execPath, '-e', largeOfflineEventScript(2_100)],
          },
        },
        out,
        options: validationOptions(out),
        basicResult: { status: 'pass', diagnosis: 'Basic Reporting passed.' },
      })

      assert.strictEqual(result.status, 'pass', JSON.stringify(result))
      assert.strictEqual(result.evidence.commandExitCode, 0)
      assert.deepStrictEqual(result.evidence.offlineExporterCapture, {
        mode: 'sample',
        completionCount: 1,
        observedEventCount: 2_103,
        retainedEventCount: 11,
        sampled: true,
      })
      assert.deepStrictEqual(result.evidence.ciCommandExecution, {
        mode: 'full-replay',
        fullReplayRan: true,
      })
      assert.strictEqual(result.evidence.testSessionEvents, 1)
      assert.strictEqual(result.evidence.testModuleEvents, 1)
      assert.strictEqual(result.evidence.testSuiteEvents, 1)
      assert.strictEqual(result.evidence.testEvents, 8)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('uses a no-events live replay as the evidence for genuinely missing CI initialization', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
    const fullReplayMarker = path.join(out, 'full-replay-ran')

    try {
      const result = await runCiWiring({
        manifest: { repository: { root: out } },
        framework: {
          id: 'vitest:root',
          framework: 'vitest',
          project: { root: out },
          ciWiring: {
            initialization: {
              status: 'not_configured',
              evidence: ['The unit job defines no NODE_OPTIONS or Datadog environment variables.'],
            },
          },
          ciWiringCommand: {
            cwd: out,
            argv: [process.execPath, '-e', [
              `require('node:fs').writeFileSync(${JSON.stringify(fullReplayMarker)}, 'ran')`,
              'console.log("Tests 1 passed")',
            ].join(';')],
          },
        },
        out,
        options: validationOptions(out),
        basicResult: { status: 'pass', diagnosis: 'Basic Reporting passed.' },
      })

      assert.strictEqual(result.status, 'fail', JSON.stringify(result))
      assert.strictEqual(fs.readFileSync(fullReplayMarker, 'utf8'), 'ran')
      assert.deepStrictEqual(result.evidence.ciCommandExecution, {
        mode: 'full-replay',
        fullReplayRan: true,
      })
      assert.deepStrictEqual(result.evidence.offlineExporterCapture, {
        mode: undefined,
        completionCount: 0,
        observedEventCount: 0,
        retainedEventCount: 0,
        sampled: false,
      })
      assert.strictEqual(result.evidence.commandExitCode, 0)
      assert.strictEqual(result.evidence.eventLevelFailure.kind, 'ci-wiring-no-test-optimization-events')
      assert.match(result.diagnosis, /ran tests/)
      assert.doesNotMatch(JSON.stringify(result.evidence), /initialization-probe-only/)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('treats monorepo runner success summaries as evidence that tests ran', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
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
        out,
        options: validationOptions(out),
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
        out,
        options: validationOptions(out),
        basicResult: {
          status: 'pass',
          diagnosis: 'Basic reporting emitted session, module, suite, and test events.',
        },
      })

      assert.strictEqual(result.status, 'error')
      assert.strictEqual(result.evidence.commandExitCode, 1)
      assert.strictEqual(result.evidence.eventLevelFailure.kind, 'ci-wiring-command-failed-after-tests')
      assert.match(result.diagnosis, /ran tests but exited 1/)
      assert.doesNotMatch(result.diagnosis, /failed before tests/)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('keeps a focused CI replay inconclusive when wrapper forwarding runs a broad suite', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
    const command = {
      cwd: out,
      argv: [process.execPath, '-e', 'console.log("52 passing")'],
    }
    try {
      const result = await runCiWiring({
        framework: {
          id: 'mocha:root',
          framework: 'mocha',
          existingTestCommand: command,
          ciWiringCommand: command,
          preflight: {
            ran: true,
            exitCode: 0,
            observedTestCount: 1,
            maxTestCount: 1,
          },
        },
        out,
        options: validationOptions(out),
      })

      assert.strictEqual(result.status, 'error')
      assert.strictEqual(result.evidence.validationIncomplete, true)
      assert.strictEqual(result.evidence.observedTestCount, 52)
      assert.strictEqual(result.evidence.commandFailure.kind, 'ci-wiring-representative-scope-mismatch')
      assert.match(result.diagnosis, /outside the approved representative scope of at most 1/)
      assert.match(result.evidence.commandFailure.recommendation, /wrapper argument forwarding/)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('ignores manifest-authored CI preflight evidence for a different command shape', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
    try {
      const result = await runCiWiring({
        framework: {
          id: 'mocha:root',
          framework: 'mocha',
          existingTestCommand: {
            cwd: out,
            argv: [process.execPath, '-e', 'console.log("1 passing")'],
          },
          ciWiringCommand: {
            cwd: out,
            argv: [process.execPath, '-e', 'console.log("52 passing")'],
          },
          ciWiringPreflight: {
            ran: true,
            exitCode: 0,
            observedTestCount: 1,
            maxTestCount: 1,
          },
        },
        out,
        options: validationOptions(out),
        basicResult: { status: 'pass' },
      })

      assert.strictEqual(result.status, 'fail')
      assert.strictEqual(result.evidence.preflight.ran, false)
      assert.strictEqual(result.evidence.eventLevelFailure.kind, 'ci-wiring-no-test-optimization-events')
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('probes CI wiring when test output shows failing tests', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
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
        out,
        options: validationOptions(out),
        basicResult: {
          status: 'pass',
          diagnosis: 'Basic reporting emitted session, module, suite, and test events.',
        },
      })

      assert.strictEqual(result.status, 'error')
      assert.strictEqual(result.evidence.commandExitCode, 1)
      assert.match(result.diagnosis, /ran tests but exited 1/)
      assert.strictEqual(result.evidence.initializationProbe.ran, true)
      assert.strictEqual(result.evidence.initializationProbe.reachedAnyNodeProcess, true)
      assert.strictEqual(result.evidence.initializationProbe.reachedTestRunnerProcess, false)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('does not match CI wiring exit codes against unrelated existing-command preflight', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))

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
            argv: [process.execPath, '-e', offlineEventScript([
              { type: 'test_session_end' },
              { type: 'test_module_end' },
              { type: 'test_suite_end' },
              { type: 'test' },
            ], 7)],
          },
          preflight: {
            ran: true,
            exitCode: 7,
            observedTestCount: 1,
          },
        },
        out,
        options: validationOptions(out),
        basicResult: {
          status: 'pass',
          diagnosis: 'Basic reporting emitted session, module, suite, and test events.',
        },
      })

      assert.strictEqual(result.status, 'error')
      assert.strictEqual(result.evidence.commandExitMatchesPreflight, false)
      assert.deepStrictEqual(result.evidence.preflight, {
        ran: false,
        reason: 'No dd-trace-less preflight result was recorded for the selected CI wiring command shape.',
      })
      assert.match(result.diagnosis, /emitted Test Optimization events but exited 7/)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('does not report preload resolution failure when output proves tests ran', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
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
        out,
        options: validationOptions(out),
        basicResult: {
          status: 'pass',
          diagnosis: 'Basic reporting emitted session, module, suite, and test events.',
        },
      })

      assert.strictEqual(result.status, 'error')
      assert.strictEqual(result.evidence.commandFailure, undefined)
      assert.strictEqual(result.evidence.eventLevelFailure.kind, 'ci-wiring-command-failed-after-tests')
      assert.match(result.diagnosis, /ran tests but exited 1/)
      assert.doesNotMatch(result.diagnosis, /failed before tests started/)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('classifies dd-trace preload resolution failures before test execution', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
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
        out,
        options: validationOptions(out),
        basicResult: {
          status: 'pass',
          diagnosis: 'Basic reporting emitted session, module, suite, and test events.',
        },
      })

      assert.strictEqual(result.status, 'error')
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

  it('classifies focused CI commands that match no test files as incomplete', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
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
        out,
        options: validationOptions(out),
      })

      assert.strictEqual(result.status, 'error')
      assert.strictEqual(result.evidence.commandExitCode, 3)
      assert.strictEqual(result.evidence.validationIncomplete, true)
      assert.strictEqual(result.evidence.commandFailure.kind, 'ci-wiring-test-filter-mismatch')
      assert.strictEqual(result.evidence.eventLevelFailure.kind, 'ci-wiring-test-filter-mismatch')
      assert.match(result.diagnosis, /focused test filter matched no files/)
      assert.match(result.diagnosis, /No CI wiring conclusion was reached/)
      assert.match(result.evidence.commandFailure.recommendation, /exact CI-loaded project/)
      assert.doesNotMatch(result.diagnosis, /process may not have written the event artifact/)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('classifies Watchman filesystem denials as execution-environment blockers', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
    try {
      const result = await runCiWiring({
        framework: {
          id: 'jest:root',
          framework: 'jest',
          ciWiringCommand: {
            cwd: out,
            argv: [
              process.execPath,
              '-e',
              'console.error("Watchman: fchmod(/home/user/.local/state/watchman/state): ' +
                'Operation not permitted"); process.exit(1)',
            ],
          },
        },
        out,
        options: validationOptions(out),
      })

      assert.strictEqual(result.status, 'error')
      assert.strictEqual(result.evidence.validationIncomplete, true)
      assert.strictEqual(result.evidence.commandFailure.kind, 'watchman-filesystem-blocked')
      assert.strictEqual(result.evidence.eventLevelFailure.kind, 'watchman-filesystem-blocked')
      assert.match(result.diagnosis, /execution environment blocked Watchman state access before tests started/)
      assert.match(result.evidence.commandFailure.recommendation, /Watchman can access its state directory/)
      assert.doesNotMatch(result.diagnosis, /Test Optimization initialization/)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('classifies an invented Vitest project filter as incomplete', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
    try {
      const result = await runCiWiring({
        framework: {
          id: 'vitest:date-fns',
          framework: 'vitest',
          ciWiringCommand: {
            cwd: out,
            argv: [
              process.execPath,
              '-e',
              'console.error(\'Error: No projects matched the filter "main".\'); process.exit(1)',
            ],
          },
        },
        out,
        options: validationOptions(out),
      })

      assert.strictEqual(result.status, 'error')
      assert.strictEqual(result.evidence.validationIncomplete, true)
      assert.strictEqual(result.evidence.commandFailure.kind, 'ci-wiring-project-filter-mismatch')
      assert.strictEqual(result.evidence.eventLevelFailure.kind, 'ci-wiring-project-filter-mismatch')
      assert.match(result.diagnosis, /project filter `main` is not exposed/)
      assert.match(result.evidence.commandFailure.recommendation, /Remove the invented project selector/)
      assert.match(result.evidence.commandFailure.recommendation, /project the original CI command actually loads/)
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('does not classify unrelated preload failures as dd-trace preload failures', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-ci-wiring-'))
    const command = {
      cwd: out,
      argv: [process.execPath, '-e', 'console.log("this should not run")'],
      env: {
        NODE_OPTIONS: '-r ./missing-preload.js',
      },
    }
    try {
      const result = await runCiWiring({
        framework: {
          id: 'mocha:fixture',
          framework: 'mocha',
          existingTestCommand: command,
          ciWiringCommand: command,
          preflight: {
            ran: true,
            exitCode: 0,
            observedTestCount: 1,
            maxTestCount: 1,
          },
        },
        out,
        options: validationOptions(out),
      })

      assert.strictEqual(result.status, 'error')
      assert.strictEqual(result.evidence.validationIncomplete, true)
      assert.strictEqual(result.evidence.commandFailure.kind, 'project-command-initialization-failed')
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

function offlineEventScript (events, exitCode = 0) {
  const sinkPath = path.resolve('packages/dd-trace/src/ci-visibility/exporters/ci-validation/sink.js')
  const writerPath = path.resolve('packages/dd-trace/src/ci-visibility/exporters/ci-validation/writer.js')
  const idPath = path.resolve('packages/dd-trace/src/id.js')
  return [
    `const { CiValidationSink } = require(${JSON.stringify(sinkPath)})`,
    `const CiValidationWriter = require(${JSON.stringify(writerPath)})`,
    `const id = require(${JSON.stringify(idPath)})`,
    'const outputRoot = process.env._DD_TEST_OPTIMIZATION_VALIDATION_OUTPUT_DIR',
    'const captureMode = process.env._DD_TEST_OPTIMIZATION_VALIDATION_CAPTURE_MODE || "strict"',
    'const sink = new CiValidationSink(outputRoot, { captureMode })',
    'const writer = new CiValidationWriter({ sink, tags: {} })',
    `const events = ${JSON.stringify(events)}`,
    'writer.append(events.map(({ type, meta = {} }) => ({',
    "  trace_id: id('1234abcd1234abcd'), span_id: id('1234abcd1234abcd'),",
    "  parent_id: id('0000000000000000'), name: 'example test', resource: 'example test',",
    "  service: 'validation', type, error: 0,",
    "  meta: { 'test.name': 'example test', 'test.status': 'pass', ...meta }, metrics: {},",
    '  start: 123, duration: 456,',
    '})))',
    'writer.flush()',
    'sink.writeSummary()',
    `process.exit(${exitCode})`,
  ].join('\n')
}

function largeOfflineEventScript (eventCount) {
  const sinkPath = path.resolve('packages/dd-trace/src/ci-visibility/exporters/ci-validation/sink.js')
  const writerPath = path.resolve('packages/dd-trace/src/ci-visibility/exporters/ci-validation/writer.js')
  const idPath = path.resolve('packages/dd-trace/src/id.js')
  return [
    `const { CiValidationSink } = require(${JSON.stringify(sinkPath)})`,
    `const CiValidationWriter = require(${JSON.stringify(writerPath)})`,
    `const id = require(${JSON.stringify(idPath)})`,
    'const outputRoot = process.env._DD_TEST_OPTIMIZATION_VALIDATION_OUTPUT_DIR',
    'const captureMode = process.env._DD_TEST_OPTIMIZATION_VALIDATION_CAPTURE_MODE',
    'const sink = new CiValidationSink(outputRoot, { captureMode })',
    'const writer = new CiValidationWriter({ sink, tags: {} })',
    'const spans = []',
    `for (let index = 0; index < ${eventCount}; index++) spans.push({`,
    "  trace_id: id('1234abcd1234abcd'), span_id: id('1234abcd1234abcd'),",
    "  parent_id: id('0000000000000000'), name: 'test', resource: 'test-' + index,",
    "  service: 'validation', type: 'test', error: 0,",
    "  meta: { 'test.name': 'test-' + index, 'test.status': 'pass' }, metrics: {},",
    '  start: 123, duration: 456,',
    '})',
    "for (const type of ['test_suite_end', 'test_module_end', 'test_session_end']) spans.push({",
    "  trace_id: id('1234abcd1234abcd'), span_id: id('1234abcd1234abcd'),",
    "  parent_id: id('0000000000000000'), name: type, resource: type,",
    "  service: 'validation', type, error: 0, meta: { 'test.status': 'pass' }, metrics: {},",
    '  start: 123, duration: 456,',
    '})',
    'writer.append(spans)',
    'writer.flush()',
    'sink.writeSummary()',
  ].join('\n')
}
