'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const sinon = require('sinon')

const {
  writePendingReport,
  writeReport,
} = require('../../../../ci/test-optimization-validation/report-writer')
const {
  createLoadedManifest,
  createRepositoryFixture,
  removeFixture,
} = require('./validation-test-helpers')

describe('test optimization validation report', () => {
  let fixture
  let manifest
  let out
  let consoleLog

  beforeEach(() => {
    fixture = createRepositoryFixture({ framework: 'mocha' })
    manifest = createLoadedManifest(fixture.root, 'mocha')
    out = path.join(fixture.root, 'dd-test-optimization-validation-results')
    fs.mkdirSync(out, { recursive: true })
    consoleLog = sinon.stub(console, 'log')
  })

  afterEach(() => {
    consoleLog.restore()
    removeFixture(fixture.root)
  })

  it('explains a working library and confirmed CI misconfiguration in plain language', () => {
    write([
      result('basic-reporting', 'pass', 'The direct test emitted the complete event hierarchy.', {
        foundationalReportingEstablished: true,
      }),
      result('ci-wiring', 'fail', 'Test Optimization is not initialized in the selected CI job.', {
        conclusion: 'confirmed_misconfigured',
        evidenceStrength: 'confirmed_static',
        recommendation: 'Add dd-trace/ci/init to this exact test job.',
      }),
      result('efd', 'pass', 'Early Flake Detection retry evidence was captured.'),
    ])
    const report = readReport()

    assert.match(report, /library reported this project test correctly/)
    assert.match(report, /customer CI configuration has a confirmed static problem/)
    assert.match(report, /Add dd-trace\/ci\/init to this exact test job/)
    assert.match(report, /\| PASS \|/)
    assert.match(report, /\| FAIL \|/)
    assert.doesNotMatch(report, /### .*Early Flake Detection/)
  })

  it('surfaces a confirmed advanced failure ahead of Basic Reporting success', () => {
    write([
      result('basic-reporting', 'pass', 'The direct test emitted the complete event hierarchy.', {
        foundationalReportingEstablished: true,
      }),
      result('efd', 'fail', 'The generated test did not receive an Early Flake Detection retry.', {
        evidenceStrength: 'confirmed_runtime',
      }),
    ])
    const report = readReport()

    assert.match(
      report,
      /What This Means[\s\S]*Basic Reporting passed, but Early Flake Detection failed: The generated test did not/
    )
  })

  it('distinguishes incomplete validation from a tracer failure', () => {
    write([
      result('basic-reporting', 'blocked', 'The browser could not launch in this sandbox.', {
        commandFailure: { blockedByExecutionEnvironment: true },
        recommendation: 'Run the exact approved command in a normal project terminal.',
        validationIncomplete: true,
      }),
      result('ci-wiring', 'error', 'The wrapper chain could not be resolved.', {
        ciFacts: {
          initialization: { status: 'missing' },
          runnerInvocation: { status: 'unresolved' },
        },
        conclusion: 'incomplete',
        validationIncomplete: true,
      }),
    ], {
      executionStatus: 'incomplete',
      validationCoverage: 'partial',
      validatorExitCode: 2,
    })
    const report = readReport()

    assert.match(report, /\*\*Status: INCOMPLETE\*\*/)
    assert.match(report, /Local library behavior was not validated/)
    assert.match(report, /\| INCOMPLETE \|/)
    assert.match(report, /"ciFacts"/)
    assert.match(report, /"initialization"[\s\S]*"status": "missing"/)
    assert.match(report, /Run the exact approved command in a normal project terminal/)
  })

  it('reports a confirmed CI problem when no local check ran', () => {
    write([
      result('ci-wiring', 'fail', 'Test Optimization is not initialized in the selected CI job.', {
        conclusion: 'confirmed_misconfigured',
        evidenceStrength: 'confirmed_static',
      }),
    ])
    const report = readReport()

    assert.match(report, /customer CI configuration has a confirmed static problem/)
    assert.match(report, /Local library behavior was not validated/)
  })

  it('leads with the specific project setup action', () => {
    write([
      result('all', 'skip', 'The selected Cypress spec needs a localhost application.', {
        blockedByProjectSetup: true,
        recommendation: 'Start the project application before validating this Cypress spec.',
        validationIncomplete: true,
      }),
    ], {
      executionStatus: 'project_setup_required',
      validationCoverage: 'partial',
      validatorExitCode: 2,
    })
    const report = readReport()

    assert.match(report, /Start the project application before validating this Cypress spec/)
  })

  it('makes a possible library bug suitable for an engineering debugging session', () => {
    const artifact = path.join(out, 'mocha-root', 'basic-reporting', 'debug', 'command.json')
    fs.mkdirSync(path.dirname(artifact), { recursive: true })
    fs.writeFileSync(artifact, '{}\n')
    const bug = result(
      'basic-reporting',
      'fail',
      'The clean test passed, but controlled initialization emitted no test events.',
      {
        commandExitCode: 0,
        missingEventLevels: ['test'],
        offlineExporterInitialized: true,
        possibleLibraryBug: true,
        recommendation: 'Attach the debug artifact and framework versions to the engineering investigation.',
      }
    )
    bug.artifacts = [artifact]
    write([bug])
    const report = readReport()

    assert.match(report, /possible library bug/)
    assert.ok(report.includes(`Artifacts: \`${path.join('mocha-root', 'basic-reporting', 'debug')}\``))
    assert.match(report, /"missingEventLevels"/)
    assert.match(report, /Attach the debug artifact/)
  })

  it('sanitizes secret-like values and keeps the report bounded', () => {
    const results = [
      result('basic-reporting', 'fail', 'Request used DD_API_KEY=super-secret-value.', {
        commandOutputSummary: ['Authorization: Bearer top-secret-token'],
        possibleLibraryBug: true,
      }),
    ]
    write(results)
    const report = readReport()

    assert.doesNotMatch(report, /super-secret-value|top-secret-token/)
    assert.match(report, /<redacted>/)
    assert.ok(report.split('\n').length < 200)
    assert.strictEqual(fs.existsSync(path.join(out, 'report.json')), false)
    assert.ok(consoleLog.lastCall.args[0].split('\n').length < 20)
  })

  it('escapes Markdown fences in untrusted structured evidence', () => {
    write([
      result('basic-reporting', 'fail', 'The command failed.', {
        commandOutputSummary: ['```', '# injected heading'],
        possibleLibraryBug: true,
      }),
    ])
    const report = readReport()

    assert.strictEqual((report.match(/```/g) || []).length, 2)
    assert.match(report, /\\u0060\\u0060\\u0060/)
    assert.doesNotMatch(report, /\n# injected heading\n/)
  })

  it('writes a clear pending report before project code executes', () => {
    writePendingReport({ manifest, out })
    const report = readReport()

    assert.match(report, /\*\*Status: INCOMPLETE\*\*/)
    assert.match(report, /did not finish/)
    assert.match(report, /Do not draw a Test Optimization conclusion/)
  })

  it('reports incomplete temporary-file cleanup explicitly', () => {
    write([
      result('basic-reporting', 'pass', 'The direct test emitted the complete event hierarchy.'),
    ], {
      cleanup: {
        directoriesRemoved: 0,
        directoriesRetained: 1,
        filesRemoved: 2,
        filesRetained: 1,
        status: 'incomplete',
      },
    })
    const report = readReport()

    assert.match(report, /Cleanup: incomplete \(2 temporary paths retained\)/)
    assert.match(consoleLog.lastCall.args[0], /Cleanup: incomplete \(2 temporary paths retained\)/)
  })

  /**
   * Writes a final report with standard run metadata.
   *
   * @param {object[]} results scenario results
   * @param {object} [runSummary] run summary
   * @returns {void}
   */
  function write (results, runSummary = {}) {
    writeReport({
      manifest,
      out,
      results,
      runSummary: {
        cleanup: { filesRemoved: 3, status: 'completed' },
        executionStatus: 'completed_with_findings',
        validationCoverage: 'complete',
        validatorExitCode: 1,
        ...runSummary,
      },
    })
  }

  /**
   * Reads the generated Markdown report.
   *
   * @returns {string} report source
   */
  function readReport () {
    return fs.readFileSync(path.join(out, 'report.md'), 'utf8')
  }

  /**
   * Builds one scenario result.
   *
   * @param {string} scenario scenario id
   * @param {string} status result status
   * @param {string} diagnosis diagnosis
   * @param {object} [evidence] evidence
   * @returns {object} result
   */
  function result (scenario, status, diagnosis, evidence = {}) {
    return {
      artifacts: [],
      diagnosis,
      evidence,
      frameworkId: manifest.frameworks[0].id,
      scenario,
      status,
    }
  }
})
