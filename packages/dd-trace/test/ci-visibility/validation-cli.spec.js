'use strict'

/* eslint-disable no-console */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const proxyquire = require('proxyquire').noCallThru().noPreserveCache()

const {
  filterFrameworks,
  normalizeFrameworkTarget,
  parseArgs,
} = require('../../../../ci/test-optimization-validation/cli')

const PASSING_VALIDATION_PHASES = {
  './approval': {
    assertApprovalDigest () {},
  },
  './generated-verifier': {
    async verifyGeneratedTestStrategy () {
      return { ok: true }
    },
  },
  './preflight-runner': {
    async runFrameworkPreflight ({ framework }) {
      framework.preflight = {
        ran: true,
        source: 'validator',
        exitCode: 0,
        observedTestCount: 1,
      }
      return { ok: true, preflight: framework.preflight }
    },
  },
}
const APPROVAL_ARGS = ['--approved-plan-sha256', 'a'.repeat(64)]

function readMarkdownJsonSection (markdown, title) {
  const pattern = new RegExp(`## ${title}\\n\\n\`\`\`json\\n([\\s\\S]*?)\\n\`\`\``)
  const match = pattern.exec(markdown)
  assert.ok(match, `Expected ${title} section`)
  return JSON.parse(match[1])
}

describe('test optimization validation cli', () => {
  it('normalizes copied framework targets with a trailing colon', () => {
    assert.strictEqual(normalizeFrameworkTarget(' vitest:root-unit: '), 'vitest:root-unit')

    const options = parseArgs(['--framework', 'vitest:root-unit:'])

    assert.deepStrictEqual([...options.frameworks], ['vitest:root-unit'])
  })

  it('selects entries by exact id or framework kind', () => {
    const frameworks = [
      { id: 'vitest:root-unit', framework: 'vitest' },
      { id: 'mocha:cjs-module', framework: 'mocha' },
      { id: 'vitest:integration', framework: 'vitest' },
    ]

    assert.deepStrictEqual(filterFrameworks(frameworks, new Set(['vitest:root-unit'])), [
      { id: 'vitest:root-unit', framework: 'vitest' },
    ])
    assert.deepStrictEqual(filterFrameworks(frameworks, new Set(['vitest'])), [
      { id: 'vitest:root-unit', framework: 'vitest' },
      { id: 'vitest:integration', framework: 'vitest' },
    ])
  })

  it('adds basic reporting as a prerequisite for advanced scenario selection', () => {
    const options = parseArgs(['--scenario', 'efd'])

    assert.deepStrictEqual([...options.scenarios], ['basic-reporting', 'efd'])
  })

  it('adds basic reporting as a prerequisite for CI wiring scenario selection', () => {
    const options = parseArgs(['--scenario', 'ci-wiring'])

    assert.deepStrictEqual([...options.scenarios], ['basic-reporting', 'ci-wiring'])
  })

  it('parses a plan approval digest for live validation', () => {
    const digest = 'a'.repeat(64)
    const options = parseArgs(['--approved-plan-sha256', digest])

    assert.strictEqual(options.approvedPlanSha256, digest)
  })

  it('validates a manifest without creating output or starting live validation', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-cli-'))
    const manifestPath = path.join(tmpDir, 'dd-test-optimization-validation-manifest.json')
    const out = path.join(tmpDir, 'results')
    const logs = []
    const originalLog = console.log
    const { main } = proxyquire('../../../../ci/test-optimization-validation/cli', {
      ...PASSING_VALIDATION_PHASES,
      './mock-intake': {
        MockIntake: class {
          constructor () {
            throw new Error('live validation should not start')
          }
        },
      },
      './static-diagnosis': {
        runStaticDiagnosis () {
          throw new Error('static diagnosis should not run')
        },
      },
    })

    fs.writeFileSync(manifestPath, `${JSON.stringify(getRunnableManifest(tmpDir), null, 2)}\n`)
    console.log = message => logs.push(message)

    try {
      await main(['--manifest', manifestPath, '--out', out, '--validate-manifest'])

      assert.strictEqual(fs.existsSync(out), false)
      assert.deepStrictEqual(logs, [`Validation manifest is valid: ${manifestPath}`])
    } finally {
      console.log = originalLog
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('fails closed before live validation when no approved plan digest is supplied', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-cli-'))
    const manifestPath = path.join(tmpDir, 'dd-test-optimization-validation-manifest.json')
    const out = path.join(tmpDir, 'results')
    const errors = []
    const originalError = console.error
    const originalExitCode = process.exitCode
    const { main } = proxyquire('../../../../ci/test-optimization-validation/cli', {
      ...PASSING_VALIDATION_PHASES,
      './mock-intake': {
        MockIntake: class {
          constructor () {
            throw new Error('live validation should not start')
          }
        },
      },
    })

    fs.writeFileSync(manifestPath, `${JSON.stringify(getRunnableManifest(tmpDir), null, 2)}\n`)
    console.error = error => errors.push(String(error))
    process.exitCode = undefined

    try {
      await main(['--manifest', manifestPath, '--out', out])

      assert.strictEqual(process.exitCode, 1)
      assert.strictEqual(fs.existsSync(out), false)
      assert.match(errors.join('\n'), /requires the --approved-plan-sha256 value/)
    } finally {
      console.error = originalError
      process.exitCode = originalExitCode
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('prints phase progress during live validation without requiring verbose mode', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-progress-'))
    const manifestPath = path.join(tmpDir, 'dd-test-optimization-validation-manifest.json')
    const out = path.join(tmpDir, 'results')
    const logs = []
    const originalLog = console.log
    const originalExitCode = process.exitCode
    const { main } = proxyquire('../../../../ci/test-optimization-validation/cli', {
      ...PASSING_VALIDATION_PHASES,
      './mock-intake': {
        MockIntake: class {
          constructor () {
            this.requests = []
          }

          async start () {}
          async close () {}
        },
      },
      './report-writer': {
        async writeReport () {},
      },
      './scenarios/basic-reporting': {
        async runBasicReporting ({ framework }) {
          return {
            frameworkId: framework.id,
            scenario: 'basic-reporting',
            status: 'pass',
            diagnosis: 'Basic Reporting passed.',
            evidence: {},
            artifacts: [],
          }
        },
      },
      './setup-runner': {
        async runSetupCommands () {
          return { ok: true }
        },
      },
      './static-diagnosis': {
        getStaticBlocker () {
          return null
        },
        runStaticDiagnosis () {
          return { report: {} }
        },
      },
    })

    fs.writeFileSync(manifestPath, `${JSON.stringify(getRunnableManifest(tmpDir), null, 2)}\n`)
    console.log = message => logs.push(message)
    process.exitCode = undefined

    try {
      await main([
        '--manifest', manifestPath,
        '--out', out,
        '--scenario', 'basic-reporting',
        ...APPROVAL_ARGS,
      ])

      assert.deepStrictEqual(logs, [
        '[test-optimization-validator] Starting the local mock intake.',
        '[test-optimization-validator] Local mock intake ready.',
        '[test-optimization-validator] jest:root: Test execution without Datadog started.',
        '[test-optimization-validator] jest:root: Test execution without Datadog pass.',
        '[test-optimization-validator] jest:root: Basic Reporting started.',
        '[test-optimization-validator] jest:root: Basic Reporting pass.',
      ])
      assert.strictEqual(process.exitCode, 0)
    } finally {
      console.log = originalLog
      process.exitCode = originalExitCode
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('refuses to use repository.root itself as the validation output directory', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-cli-'))
    const manifestPath = path.join(tmpDir, 'dd-test-optimization-validation-manifest.json')
    const errors = []
    const originalError = console.error
    const originalExitCode = process.exitCode
    const { main } = proxyquire('../../../../ci/test-optimization-validation/cli', {
      ...PASSING_VALIDATION_PHASES,
    })

    fs.writeFileSync(manifestPath, `${JSON.stringify(getRunnableManifest(tmpDir), null, 2)}\n`)
    console.error = error => errors.push(String(error))
    process.exitCode = undefined

    try {
      await main(['--manifest', manifestPath, '--out', tmpDir, ...APPROVAL_ARGS])

      assert.strictEqual(process.exitCode, 1)
      assert.match(errors.join('\n'), /dedicated child directory inside repository.root/)
    } finally {
      console.error = originalError
      process.exitCode = originalExitCode
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('exits unsuccessfully when a selected advanced feature has only a proposed strategy', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-cli-'))
    const manifestPath = path.join(tmpDir, 'dd-test-optimization-validation-manifest.json')
    const out = path.join(tmpDir, 'results')
    const manifest = getRunnableManifest(tmpDir)
    const originalExitCode = process.exitCode
    const { main } = proxyquire('../../../../ci/test-optimization-validation/cli', {
      ...PASSING_VALIDATION_PHASES,
      './mock-intake': {
        MockIntake: class {
          constructor () {
            this.requests = []
          }

          async start () {}
          async close () {}
        },
      },
      './report-writer': {
        async writeReport () {},
      },
      './scenarios/basic-reporting': {
        async runBasicReporting ({ framework }) {
          return {
            frameworkId: framework.id,
            scenario: 'basic-reporting',
            status: 'pass',
            diagnosis: 'Basic Reporting passed.',
            evidence: {},
            artifacts: [],
          }
        },
      },
      './setup-runner': {
        async runSetupCommands () {
          return { ok: true }
        },
      },
      './static-diagnosis': {
        getStaticBlocker () {
          return null
        },
        runStaticDiagnosis () {
          return { report: {} }
        },
      },
    })

    manifest.frameworks[0].generatedTestStrategy = {
      status: 'proposed',
      reason: 'The generated test command has not been verified.',
    }
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    process.exitCode = undefined

    try {
      await main(['--manifest', manifestPath, '--out', out, '--scenario', 'efd', ...APPROVAL_ARGS])

      assert.strictEqual(process.exitCode, 1)
    } finally {
      process.exitCode = originalExitCode
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  for (const code of ['EPERM', 'EACCES']) {
    it(`reports fake intake startup ${code} listen failures as execution-environment blockers`, async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-cli-'))
      const out = path.join(tmpDir, 'results')
      const manifestPath = path.join(tmpDir, 'dd-test-optimization-validation-manifest.json')
      const staticDiagnosisPath = path.join(out, 'static-diagnosis.json')
      const error = Object.assign(new Error(`listen ${code}: operation not permitted 127.0.0.1`), {
        address: '127.0.0.1',
        code,
        syscall: 'listen',
      })
      const { main } = proxyquire('../../../../ci/test-optimization-validation/cli', {
        ...PASSING_VALIDATION_PHASES,
        './mock-intake': {
          MockIntake: class {
            constructor ({ out }) {
              this.out = out
              this.requests = []
            }

            async start () {
              throw error
            }

            async close () {}

            writeArtifacts () {
              const intakeDir = path.join(this.out, 'intake')
              fs.mkdirSync(intakeDir, { recursive: true })
              const requestsPath = path.join(intakeDir, 'requests.ndjson')
              fs.writeFileSync(requestsPath, '')
              return { requestsPath }
            }
          },
        },
        './setup-runner': {
          runSetupCommands () {
            throw new Error('setup commands should not run when the fake intake cannot start')
          },
        },
        './static-diagnosis': {
          getStaticBlocker () {
            return null
          },
          runStaticDiagnosis () {
            fs.mkdirSync(out, { recursive: true })
            fs.writeFileSync(staticDiagnosisPath, '{}\n')
            return {
              report: {},
              reportPath: staticDiagnosisPath,
            }
          },
        },
      })
      const manifest = getRunnableManifest(tmpDir)
      const originalExitCode = process.exitCode
      const originalLog = console.log
      const logs = []

      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      console.log = message => logs.push(message)
      process.exitCode = undefined

      try {
        await main(['--manifest', manifestPath, '--out', out, ...APPROVAL_ARGS])

        const markdown = fs.readFileSync(path.join(out, 'report.md'), 'utf8')
        const reportResults = readMarkdownJsonSection(markdown, 'Execution Results JSON')
        const validationPayloads = readMarkdownJsonSection(markdown, 'Validation Payloads JSON')
        const summary = logs.join('\n')

        assert.strictEqual(process.exitCode, 1)
        assert.strictEqual(reportResults[0].status, 'blocked')
        assert.strictEqual(reportResults[0].evidence.blockedByExecutionEnvironment, true)
        assert.strictEqual(reportResults[0].evidence.errorCode, code)
        assert.strictEqual(validationPayloads[0].payload.status, 'unknown')
        assert.strictEqual(validationPayloads[0].payload.checks[0].id, 'execution-environment')
        assert.strictEqual(validationPayloads[0].payload.checks[0].status, 'unknown')
        assert.match(summary, /environment blocks localhost sockets/)
        assert.match(summary, /Rerun the validator outside the restricted sandbox/)
        assert.match(summary, /Detailed report: .*report\.md/)
        assert.strictEqual(fs.existsSync(path.join(out, 'report.json')), false)
        assert.strictEqual(fs.existsSync(path.join(out, 'report.html')), false)
        assert.strictEqual(fs.existsSync(path.join(out, 'validation-payloads.json')), false)
      } finally {
        console.log = originalLog
        process.exitCode = originalExitCode
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })
  }

  it('skips CI wiring when direct-initialization Basic Reporting fails', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-cli-'))
    const out = path.join(tmpDir, 'results')
    const manifestPath = path.join(tmpDir, 'dd-test-optimization-validation-manifest.json')
    const staticDiagnosisPath = path.join(out, 'static-diagnosis.json')
    let capturedResults
    const { main } = proxyquire('../../../../ci/test-optimization-validation/cli', {
      ...PASSING_VALIDATION_PHASES,
      './mock-intake': {
        MockIntake: class {
          constructor () {
            this.requests = []
          }

          async start () {}
          async close () {}

          writeArtifacts () {
            return writeEmptyRequestsArtifact(out)
          }
        },
      },
      './setup-runner': {
        async runSetupCommands () {
          return { ok: true }
        },
      },
      './static-diagnosis': {
        getStaticBlocker () {
          return null
        },
        runStaticDiagnosis () {
          fs.mkdirSync(out, { recursive: true })
          fs.writeFileSync(staticDiagnosisPath, '{}\n')
          return {
            report: {},
            reportPath: staticDiagnosisPath,
          }
        },
      },
      './scenarios/basic-reporting': {
        async runBasicReporting ({ framework }) {
          return {
            frameworkId: framework.id,
            scenario: 'basic-reporting',
            status: 'fail',
            diagnosis: 'Basic Reporting did not emit events with direct Datadog initialization.',
            evidence: {},
            artifacts: [],
          }
        },
      },
      './scenarios/ci-wiring': {
        async runCiWiring () {
          throw new Error('CI wiring should not run until Basic Reporting passes')
        },
      },
      './generated-files': {
        async cleanupGeneratedFiles () {},
      },
      './report-writer': {
        async writeReport ({ results }) {
          capturedResults = results
        },
      },
    })
    const manifest = getRunnableManifest(tmpDir)
    const originalExitCode = process.exitCode

    setReplayableCiWiring(manifest.frameworks[0], tmpDir)
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    process.exitCode = undefined

    try {
      await main(['--manifest', manifestPath, '--out', out, ...APPROVAL_ARGS])

      assert.strictEqual(process.exitCode, 1)
      assert.deepStrictEqual(capturedResults.map(result => `${result.scenario}:${result.status}`), [
        'basic-reporting:fail',
        'ci-wiring:skip',
        'efd:skip',
        'atr:skip',
        'test-management:skip',
      ])
      assert.match(capturedResults[1].diagnosis, /Skipped CI wiring validation because Basic Reporting/)
      assert.strictEqual(capturedResults[1].evidence.basicReportingStatus, 'fail')
      assert.deepStrictEqual(capturedResults[1].evidence.featureEligibility, {
        eligible: false,
        blockedBy: 'basic-reporting',
        reasonCode: 'basic-reporting-failed',
        scenario: 'ci-wiring',
      })
      assert.deepStrictEqual(capturedResults[2].evidence.featureEligibility, {
        eligible: false,
        blockedBy: 'basic-reporting',
        reasonCode: 'basic-reporting-failed',
        scenario: 'efd',
      })
    } finally {
      process.exitCode = originalExitCode
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('does not run CI wiring when only Basic Reporting is selected', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-cli-'))
    const out = path.join(tmpDir, 'results')
    const manifestPath = path.join(tmpDir, 'dd-test-optimization-validation-manifest.json')
    const staticDiagnosisPath = path.join(out, 'static-diagnosis.json')
    let capturedResults
    const { main } = proxyquire('../../../../ci/test-optimization-validation/cli', {
      ...PASSING_VALIDATION_PHASES,
      './mock-intake': {
        MockIntake: class {
          constructor () {
            this.requests = []
          }

          async start () {}
          async close () {}

          writeArtifacts () {
            return writeEmptyRequestsArtifact(out)
          }
        },
      },
      './setup-runner': {
        async runSetupCommands () {
          return { ok: true }
        },
      },
      './static-diagnosis': {
        getStaticBlocker () {
          return null
        },
        runStaticDiagnosis () {
          fs.mkdirSync(out, { recursive: true })
          fs.writeFileSync(staticDiagnosisPath, '{}\n')
          return {
            report: {},
            reportPath: staticDiagnosisPath,
          }
        },
      },
      './scenarios/basic-reporting': {
        async runBasicReporting ({ framework }) {
          return {
            frameworkId: framework.id,
            scenario: 'basic-reporting',
            status: 'pass',
            diagnosis: 'Basic reporting emitted session, module, suite, and test events.',
            evidence: {},
            artifacts: [],
          }
        },
      },
      './scenarios/ci-wiring': {
        async runCiWiring () {
          throw new Error('CI wiring should not run when only Basic Reporting is selected')
        },
      },
      './generated-files': {
        async cleanupGeneratedFiles () {},
      },
      './report-writer': {
        async writeReport ({ results }) {
          capturedResults = results
        },
      },
    })
    const manifest = getRunnableManifest(tmpDir)
    const originalExitCode = process.exitCode

    setReplayableCiWiring(manifest.frameworks[0], tmpDir)
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    process.exitCode = undefined

    try {
      await main(['--manifest', manifestPath, '--out', out, '--scenario', 'basic-reporting', ...APPROVAL_ARGS])

      assert.strictEqual(process.exitCode, 0)
      assert.deepStrictEqual(capturedResults.map(result => `${result.scenario}:${result.status}`), [
        'basic-reporting:pass',
      ])
    } finally {
      process.exitCode = originalExitCode
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('reports missing CI wiring metadata as incomplete when CI wiring is explicitly selected', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-cli-'))
    const out = path.join(tmpDir, 'results')
    const manifestPath = path.join(tmpDir, 'dd-test-optimization-validation-manifest.json')
    const staticDiagnosisPath = path.join(out, 'static-diagnosis.json')
    let capturedResults
    const { main } = proxyquire('../../../../ci/test-optimization-validation/cli', {
      ...PASSING_VALIDATION_PHASES,
      './mock-intake': {
        MockIntake: class {
          constructor () {
            this.requests = []
          }

          async start () {}
          async close () {}

          writeArtifacts () {
            return writeEmptyRequestsArtifact(out)
          }
        },
      },
      './setup-runner': {
        async runSetupCommands () {
          return { ok: true }
        },
      },
      './static-diagnosis': {
        getStaticBlocker () {
          return null
        },
        runStaticDiagnosis () {
          fs.mkdirSync(out, { recursive: true })
          fs.writeFileSync(staticDiagnosisPath, '{}\n')
          return {
            report: {},
            reportPath: staticDiagnosisPath,
          }
        },
      },
      './scenarios/basic-reporting': {
        async runBasicReporting ({ framework }) {
          return {
            frameworkId: framework.id,
            scenario: 'basic-reporting',
            status: 'pass',
            diagnosis: 'Basic reporting emitted session, module, suite, and test events.',
            evidence: {},
            artifacts: [],
          }
        },
      },
      './generated-files': {
        async cleanupGeneratedFiles () {},
      },
      './report-writer': {
        async writeReport ({ results }) {
          capturedResults = results
        },
      },
    })
    const manifest = getRunnableManifest(tmpDir)
    manifest.frameworks[0].ciWiring = {
      status: 'unknown',
      reason: 'No replayable CI command was identified.',
    }
    const originalExitCode = process.exitCode

    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    process.exitCode = undefined

    try {
      await main(['--manifest', manifestPath, '--out', out, '--scenario', 'ci-wiring', ...APPROVAL_ARGS])

      assert.strictEqual(process.exitCode, 1)
      assert.deepStrictEqual(capturedResults.map(result => `${result.scenario}:${result.status}`), [
        'basic-reporting:pass',
        'ci-wiring:error',
      ])
      assert.match(capturedResults[1].diagnosis, /manifest is incomplete: No replayable CI command was identified/)
      assert.strictEqual(capturedResults[1].evidence.manifestIncomplete, true)
      assert.strictEqual(capturedResults[1].evidence.recommendation, 'Add ciWiringCommand to the manifest when ' +
        'a CI test step can be safely replayed locally.')
    } finally {
      process.exitCode = originalExitCode
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('treats non-runnable discovery entries as non-blocking skipped diagnostics', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-cli-'))
    const out = path.join(tmpDir, 'results')
    const manifestPath = path.join(tmpDir, 'dd-test-optimization-validation-manifest.json')
    const staticDiagnosisPath = path.join(out, 'static-diagnosis.json')
    let capturedResults
    const { main } = proxyquire('../../../../ci/test-optimization-validation/cli', {
      ...PASSING_VALIDATION_PHASES,
      './mock-intake': {
        MockIntake: class {
          constructor () {
            this.requests = []
          }

          async start () {}
          async close () {}

          writeArtifacts () {
            return writeEmptyRequestsArtifact(out)
          }
        },
      },
      './setup-runner': {
        async runSetupCommands () {
          return { ok: true }
        },
      },
      './static-diagnosis': {
        getStaticBlocker () {
          return null
        },
        runStaticDiagnosis () {
          fs.mkdirSync(out, { recursive: true })
          fs.writeFileSync(staticDiagnosisPath, '{}\n')
          return {
            report: {},
            reportPath: staticDiagnosisPath,
          }
        },
      },
      './scenarios/basic-reporting': {
        async runBasicReporting ({ framework }) {
          return {
            frameworkId: framework.id,
            scenario: 'basic-reporting',
            status: 'pass',
            diagnosis: 'Basic reporting emitted session, module, suite, and test events.',
            evidence: {},
            artifacts: [],
          }
        },
      },
      './generated-files': {
        async cleanupGeneratedFiles () {},
      },
      './report-writer': {
        async writeReport ({ results }) {
          capturedResults = results
        },
      },
    })
    const manifest = getRunnableManifest(tmpDir)
    const originalExitCode = process.exitCode

    manifest.frameworks.unshift({
      id: 'jest:fixture',
      framework: 'jest',
      frameworkVersion: '29.7.0',
      status: 'requires_manual_setup',
      project: {
        root: tmpDir,
      },
      notes: [
        'The fixture requires package-specific install and build steps.',
      ],
    }, {
      id: 'node-test:root',
      framework: 'node:test',
      frameworkVersion: '22.0.0',
      status: 'unsupported_by_validator',
      project: {
        root: tmpDir,
      },
      notes: [
        'node:test is detected for diagnosis only.',
      ],
    })
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    process.exitCode = undefined

    try {
      await main(['--manifest', manifestPath, '--out', out, '--scenario', 'basic-reporting', ...APPROVAL_ARGS])

      assert.strictEqual(process.exitCode, 0)
      const statuses = capturedResults.map(result => `${result.frameworkId}:${result.scenario}:${result.status}`)

      assert.deepStrictEqual(statuses, [
        'jest:fixture:all:skip',
        'node-test:root:all:skip',
        'jest:root:basic-reporting:pass',
      ])
      assert.match(capturedResults[0].diagnosis, /no runnable validation command/)
      assert.strictEqual(capturedResults[0].evidence.frameworkStatus, 'requires_manual_setup')
      assert.match(capturedResults[1].diagnosis, /not supported/)
      assert.strictEqual(capturedResults[1].evidence.frameworkStatus, 'unsupported_by_validator')
    } finally {
      process.exitCode = originalExitCode
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('includes Mocha rc files in non-runnable status evidence', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-cli-'))
    const out = path.join(tmpDir, 'results')
    const manifestPath = path.join(tmpDir, 'dd-test-optimization-validation-manifest.json')
    const staticDiagnosisPath = path.join(out, 'static-diagnosis.json')
    let capturedResults
    const { main } = proxyquire('../../../../ci/test-optimization-validation/cli', {
      ...PASSING_VALIDATION_PHASES,
      './mock-intake': {
        MockIntake: class {
          async start () {
            throw new Error('intake should not start for non-runnable-only manifests')
          }

          async close () {}

          writeArtifacts () {
            return writeEmptyRequestsArtifact(out)
          }
        },
      },
      './setup-runner': {
        async runSetupCommands () {
          throw new Error('setup should not run for non-runnable entries')
        },
      },
      './static-diagnosis': {
        getStaticBlocker () {
          return null
        },
        runStaticDiagnosis () {
          fs.mkdirSync(out, { recursive: true })
          fs.writeFileSync(staticDiagnosisPath, '{}\n')
          return {
            report: {},
            reportPath: staticDiagnosisPath,
          }
        },
      },
      './generated-files': {
        async cleanupGeneratedFiles () {},
      },
      './report-writer': {
        async writeReport ({ results }) {
          capturedResults = results
        },
      },
    })
    const manifest = getRunnableManifest(tmpDir)
    const originalExitCode = process.exitCode

    manifest.frameworks = [
      {
        id: 'mocha:root',
        framework: 'mocha',
        frameworkVersion: '10.0.0',
        status: 'requires_manual_setup',
        project: {
          root: tmpDir,
        },
        notes: [
          'No small representative Mocha command was selected.',
        ],
      },
    ]
    fs.writeFileSync(path.join(tmpDir, 'package.json'), `${JSON.stringify({
      devDependencies: {
        mocha: '10.0.0',
      },
    }, null, 2)}\n`)
    fs.writeFileSync(path.join(tmpDir, '.mocharc.json'), '{}\n')
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    process.exitCode = undefined

    try {
      await main(['--manifest', manifestPath, '--out', out, ...APPROVAL_ARGS])

      assert.strictEqual(process.exitCode, 0)
      assert.deepStrictEqual(capturedResults[0].evidence.configFiles, ['.mocharc.json'])
      assert.deepStrictEqual(capturedResults[0].evidence.directDependency, {
        field: 'devDependencies',
        version: '10.0.0',
      })
    } finally {
      process.exitCode = originalExitCode
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('uses static diagnosis framework config patterns in non-runnable status evidence', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-cli-'))
    const out = path.join(tmpDir, 'results')
    const manifestPath = path.join(tmpDir, 'dd-test-optimization-validation-manifest.json')
    const staticDiagnosisPath = path.join(out, 'static-diagnosis.json')
    let capturedResults
    const { main } = proxyquire('../../../../ci/test-optimization-validation/cli', {
      ...PASSING_VALIDATION_PHASES,
      './mock-intake': {
        MockIntake: class {
          async start () {
            throw new Error('intake should not start for non-runnable-only manifests')
          }

          async close () {}

          writeArtifacts () {
            return writeEmptyRequestsArtifact(out)
          }
        },
      },
      './setup-runner': {
        async runSetupCommands () {
          throw new Error('setup should not run for non-runnable entries')
        },
      },
      './static-diagnosis': {
        getStaticBlocker () {
          return null
        },
        runStaticDiagnosis () {
          fs.mkdirSync(out, { recursive: true })
          fs.writeFileSync(staticDiagnosisPath, '{}\n')
          return {
            report: {},
            reportPath: staticDiagnosisPath,
          }
        },
      },
      './generated-files': {
        async cleanupGeneratedFiles () {},
      },
      './report-writer': {
        async writeReport ({ results }) {
          capturedResults = results
        },
      },
    })
    const originalExitCode = process.exitCode
    const manifest = getRunnableManifest(tmpDir)

    manifest.frameworks = [
      {
        id: 'jest:root',
        framework: 'jest',
        frameworkVersion: '29.7.0',
        status: 'requires_manual_setup',
        project: { root: tmpDir },
        notes: ['No representative Jest command was selected.'],
      },
      {
        id: 'cypress:root',
        framework: 'cypress',
        frameworkVersion: '13.0.0',
        status: 'requires_manual_setup',
        project: { root: tmpDir },
        notes: ['No representative Cypress command was selected.'],
      },
      {
        id: 'cucumber:root',
        framework: 'cucumber',
        frameworkVersion: '10.0.0',
        status: 'requires_manual_setup',
        project: { root: tmpDir },
        notes: ['No representative Cucumber command was selected.'],
      },
    ]
    fs.writeFileSync(path.join(tmpDir, 'config-jest.js'), 'module.exports = {}\n')
    fs.writeFileSync(path.join(tmpDir, 'cypress.json'), '{}\n')
    fs.writeFileSync(path.join(tmpDir, 'cucumber.js'), 'module.exports = {}\n')
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    process.exitCode = undefined

    try {
      await main(['--manifest', manifestPath, '--out', out, ...APPROVAL_ARGS])

      assert.strictEqual(process.exitCode, 0)
      assert.deepStrictEqual(capturedResults.map(result => result.evidence.configFiles), [
        ['config-jest.js'],
        ['cypress.json'],
        ['cucumber.js'],
      ])
    } finally {
      process.exitCode = originalExitCode
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

function getRunnableManifest (root) {
  return {
    schemaVersion: '1.0',
    repository: {
      root,
      packageManager: 'npm',
      workspaceManager: 'none',
    },
    environment: {
      os: 'darwin',
    },
    frameworks: [
      {
        id: 'jest:root',
        framework: 'jest',
        frameworkVersion: '30.1.3',
        status: 'runnable',
        project: {
          root,
        },
        existingTestCommand: {
          cwd: root,
          argv: ['npm', 'test'],
        },
        preflight: {
          ran: true,
          exitCode: 0,
        },
        ciWiring: {
          status: 'skip',
          reason: 'No CI test job was found in this fixture.',
        },
      },
    ],
  }
}

function setReplayableCiWiring (framework, root) {
  framework.ciWiring = {
    status: 'fail',
    provider: 'github-actions',
    configFile: path.join(root, '.github', 'workflows', 'test.yml'),
    job: 'test',
    step: 'Run tests',
    workingDirectory: root,
    whySelected: 'The step runs the selected representative test command.',
  }
  framework.ciWiringCommand = {
    cwd: root,
    argv: [process.execPath, '-e', 'console.log("1 passing")'],
  }
}

function writeEmptyRequestsArtifact (out) {
  const intakeDir = path.join(out, 'intake')
  fs.mkdirSync(intakeDir, { recursive: true })
  const requestsPath = path.join(intakeDir, 'requests.ndjson')
  fs.writeFileSync(requestsPath, '')
  return { requestsPath }
}
