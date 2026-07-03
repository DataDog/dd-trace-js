'use strict'

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
        await main(['--manifest', manifestPath, '--out', out])

        const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'))
        const validationPayloads = JSON.parse(fs.readFileSync(path.join(out, 'validation-payloads.json'), 'utf8'))
        const summary = logs.join('\n')

        assert.strictEqual(process.exitCode, 1)
        assert.strictEqual(report.results[0].status, 'blocked')
        assert.strictEqual(report.results[0].evidence.blockedByExecutionEnvironment, true)
        assert.strictEqual(report.results[0].evidence.errorCode, code)
        assert.strictEqual(validationPayloads[0].payload.status, 'unknown')
        assert.strictEqual(validationPayloads[0].payload.checks[0].id, 'execution-environment')
        assert.strictEqual(validationPayloads[0].payload.checks[0].status, 'unknown')
        assert.match(summary, /environment blocks localhost sockets/)
        assert.match(summary, /Rerun the validator outside the restricted sandbox/)
      } finally {
        console.log = originalLog
        process.exitCode = originalExitCode
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })
  }

  it('skips CI wiring when forced local Basic Reporting fails', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-cli-'))
    const out = path.join(tmpDir, 'results')
    const manifestPath = path.join(tmpDir, 'dd-test-optimization-validation-manifest.json')
    const staticDiagnosisPath = path.join(out, 'static-diagnosis.json')
    let capturedResults
    const { main } = proxyquire('../../../../ci/test-optimization-validation/cli', {
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
            diagnosis: 'Forced local Basic Reporting did not emit events.',
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

    manifest.frameworks[0].ciWiringCommand = {
      cwd: tmpDir,
      argv: [process.execPath, '-e', 'console.log("1 passing")'],
    }
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    process.exitCode = undefined

    try {
      await main(['--manifest', manifestPath, '--out', out])

      assert.strictEqual(process.exitCode, 1)
      assert.deepStrictEqual(capturedResults.map(result => `${result.scenario}:${result.status}`), [
        'basic-reporting:fail',
        'ci-wiring:skip',
        'efd:skip',
        'atr:skip',
        'test-management:skip',
      ])
      assert.match(capturedResults[1].diagnosis, /Skipped CI wiring validation because forced local Basic Reporting/)
      assert.strictEqual(capturedResults[1].evidence.basicReportingStatus, 'fail')
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
      await main(['--manifest', manifestPath, '--out', out, '--scenario', 'basic-reporting'])

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
      },
    ],
  }
}

function writeEmptyRequestsArtifact (out) {
  const intakeDir = path.join(out, 'intake')
  fs.mkdirSync(intakeDir, { recursive: true })
  const requestsPath = path.join(intakeDir, 'requests.ndjson')
  fs.writeFileSync(requestsPath, '')
  return { requestsPath }
}
