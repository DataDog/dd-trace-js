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
        ciConfigurationStatus: 'not_configured',
        conclusion: 'confirmed_misconfigured',
        evidenceStrength: 'confirmed_static',
        recommendation: 'Add dd-trace/ci/init to this exact test job.',
      }),
      result('efd', 'pass', 'Early Flake Detection retry evidence was captured.'),
    ])
    const report = readReport()

    assert.match(report, /\*\*Report state: FINAL\*\*/)
    assert.match(report, /Local library compatibility/)
    assert.match(report, /PASS — controlled offline reporting worked/)
    assert.match(report, /NOT CONFIGURED — initialization or reporting transport is missing/)
    assert.match(report, /Add dd-trace\/ci\/init to this exact test job/)
    assert.match(report, /\| PASS \|/)
    assert.match(report, /\| NOT CONFIGURED \|/)
    assert.doesNotMatch(report, /### .*Early Flake Detection/)
  })

  it('labels only the execution plan carrying the current approval digest', () => {
    const approvedPlanSha256 = 'a'.repeat(64)
    const planPath = path.join(out, 'execution-plan.md')
    fs.writeFileSync(planPath, `node validator.js --sha256 ${'b'.repeat(64)}\n`)

    write([], { approvedPlanSha256 })
    assert.doesNotMatch(readReport(), /Approved execution plan/)

    fs.writeFileSync(planPath, `node validator.js --sha256 ${approvedPlanSha256}\n`)
    write([], { approvedPlanSha256 })
    assert.match(readReport(), /Approved execution plan: `execution-plan\.md`/)
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

    assert.match(report, /What This Means[\s\S]*ACTION REQUIRED — Early Flake Detection/)
    assert.match(report, /The generated test did not receive an Early Flake Detection retry/)
  })

  it('reports unavailable generated checks as incomplete instead of not eligible', () => {
    const recommendation = 'Report the generated-test collection limitation to validator engineering.'
    write([
      result('basic-reporting', 'pass', 'The direct test emitted the complete event hierarchy.'),
      result('efd', 'skip', 'The generated test strategy is unavailable.', {
        blockerCategory: 'VALIDATOR_LIMITATION',
        featureEligibility: {
          eligible: false,
          reasonCode: 'generated-test-strategy-not-possible',
        },
        manifestIncomplete: true,
        recommendation,
      }),
    ])
    const report = readReport()

    assert.match(report, /INCOMPLETE — one or more selected checks were not reached/)
    assert.doesNotMatch(report, /NOT ELIGIBLE/)
    assert.match(report, new RegExp(recommendation.replace('.', String.raw`\.`)))
  })

  it('distinguishes incomplete validation from a tracer failure', () => {
    write([
      result('basic-reporting', 'blocked', 'The browser could not launch in this sandbox.', {
        blockerCategory: 'EXECUTION_ENVIRONMENT_BLOCKED',
        commandFailure: { blockedByExecutionEnvironment: true },
        recommendation: 'Run the exact approved command in a normal project terminal.',
        validationIncomplete: true,
      }),
      result('ci-wiring', 'error', 'The wrapper chain could not be resolved.', {
        ciFacts: {
          initialization: { status: 'missing' },
          runnerInvocation: { status: 'unresolved' },
          transport: { mode: 'none', status: 'missing' },
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
    assert.match(report, /NOT VALIDATED — EXECUTION ENVIRONMENT BLOCKED/)
    assert.match(report, /\| INCOMPLETE \|/)
    assert.match(report, /"ciFacts"/)
    assert.match(report, /"initialization"[\s\S]*"status": "missing"/)
    assert.match(report, /initialization not visible; transport not visible; runner path unresolved/)
    assert.match(report, /Run the exact approved command in a normal project terminal/)
    assert.match(report, /rerun that exact CI test step with DD_TRACE_DEBUG=1/)
    assert.match(report, /Static absence alone is not a confirmed failure/)
    assert.match(report, /Validation scope: some selected checks are incomplete/)
    assert.match(
      report,
      /Validator exit code: 2 \(one or more selected checks are incomplete or blocked; completed conclusions remain valid\)/
    )
    assert.doesNotMatch(report, /^Coverage:/m)
  })

  it('formats individual and absent CI facts', () => {
    write([result('ci-wiring', 'error', 'Transport is missing.', {
      ciFacts: { transport: { status: 'missing' } },
    })])
    assert.match(readReport(), /INCOMPLETE — transport not visible/)

    write([result('ci-wiring', 'error', 'The runner path is unresolved.', {
      ciFacts: { runnerInvocation: { status: 'unresolved' } },
    })])
    assert.match(readReport(), /INCOMPLETE — runner path unresolved/)

    write([result('ci-wiring', 'error', 'No static fact is available.')])
    assert.doesNotMatch(readReport(), /INCOMPLETE —/)
  })

  it('reports a confirmed CI problem when no local check ran', () => {
    write([
      result('ci-wiring', 'fail', 'Test Optimization is not initialized in the selected CI job.', {
        ciConfigurationStatus: 'not_configured',
        conclusion: 'confirmed_misconfigured',
        evidenceStrength: 'confirmed_static',
      }),
    ])
    const report = readReport()

    assert.match(report, /NOT CONFIGURED — initialization or reporting transport is missing/)
    assert.match(report, /NOT VALIDATED/)
  })

  it('names closed-form CI incompleteness and de-duplicates blocked advanced actions', () => {
    const recommendation = 'Resolve the one static project binding before retrying validation.'
    write([
      result('basic-reporting', 'blocked', 'The project selection is unsupported.', {
        blockerCategory: 'VALIDATOR_LIMITATION',
        recommendation,
        validationIncomplete: true,
      }),
      result('efd', 'skip', 'Not reached.', {
        blockerCategory: 'VALIDATOR_LIMITATION',
        recommendation,
        validationIncomplete: true,
      }),
      result('atr', 'skip', 'Not reached.', {
        blockerCategory: 'VALIDATOR_LIMITATION',
        recommendation,
        validationIncomplete: true,
      }),
      result('ci-wiring', 'error', 'No supported CI file was found.', {
        reasonCode: 'no-supported-ci-configuration',
        validationIncomplete: true,
      }),
    ], {
      executionStatus: 'incomplete',
      validationCoverage: 'partial',
      validatorExitCode: 2,
    })
    const report = readReport()
    const nextActions = report.slice(report.indexOf('## Next Actions'), report.indexOf('## Debugging Evidence'))

    assert.match(report, /INCOMPLETE — no repository-controlled CI configuration was found/)
    assert.strictEqual(
      nextActions.match(/Resolve the one static project binding before retrying validation\./g).length,
      1
    )
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

    assert.match(report, /POSSIBLE LIBRARY BUG/)
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

    assert.match(report, /\*\*Report state: PENDING\*\*/)
    assert.match(report, /\*\*Status: PENDING\*\*/)
    assert.match(report, /did not finish/)
    assert.match(report, /not a final report/)
    assert.match(report, /Do not draw a Test Optimization conclusion/)
    assert.doesNotMatch(report, /Report state: FINAL/)
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

  it('gives validator failures a validator-specific next action', () => {
    const validatorFailure = result('all', 'error', 'The validator failed before completing orchestration.', {
      validationIncomplete: true,
      validationOrchestrationFailed: true,
    })
    validatorFailure.frameworkId = 'validator'

    write([validatorFailure], {
      executionStatus: 'validator_error',
      validationCoverage: 'partial',
      validatorExitCode: 3,
    })
    const report = readReport()

    assert.match(report, /Keep the validation artifacts and report this validator failure to engineering/)
    assert.doesNotMatch(report, /Prepare the project so the selected direct test passes/)
    assert.match(report, /Validator exit code: 3 \(validator implementation or orchestration error\)/)
  })

  it('preserves a specific recovery action for validator-owned state collisions', () => {
    const validatorBlocker = result('all', 'blocked', 'A validator output path already exists.', {
      blockerKind: 'command-output-exists',
      domain: 'validator_state',
      recommendation: 'Inspect the exact output path and approve a fresh plan.',
      validationIncomplete: true,
    })
    validatorBlocker.frameworkId = 'validator'

    write([validatorBlocker], {
      executionStatus: 'incomplete',
      validationCoverage: 'partial',
      validatorExitCode: 2,
    })
    const report = readReport()

    assert.match(report, /Inspect the exact output path and approve a fresh plan/)
    assert.doesNotMatch(report, /report this validator failure to engineering/)
    assert.match(report, /Validator exit code: 2 \(one or more selected checks are incomplete or blocked/)
  })

  it('explains a confirmed finding without calling it a validator failure', () => {
    write([
      result('basic-reporting', 'pass', 'The direct test emitted the complete event hierarchy.'),
      result('ci-wiring', 'fail', 'Test Optimization is not initialized in the selected CI job.', {
        conclusion: 'confirmed_misconfigured',
        evidenceStrength: 'confirmed_static',
      }),
    ])
    const report = readReport()
    const consoleSummary = consoleLog.lastCall.args[0]

    assert.match(report, /Validation scope: all selected checks reached a conclusion/)
    assert.match(
      report,
      /Validator exit code: 1 \(confirmed actionable finding; this does not by itself mean dd-trace or the validator failed\)/
    )
    assert.match(consoleSummary, /Validation scope: all selected checks reached a conclusion/)
    assert.match(consoleSummary, /Validator exit code: 1 \(confirmed actionable finding/)
    assert.match(consoleSummary, /^Report state: FINAL/m)
    assert.doesNotMatch(consoleSummary, /^Coverage:/m)
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
