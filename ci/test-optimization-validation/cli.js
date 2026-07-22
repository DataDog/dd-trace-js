'use strict'

/* eslint-disable no-console */

const fs = require('fs')
const path = require('path')

const { getFrameworkDefinitions } = require('../diagnose')
const { DD_MAJOR } = require('../../version')

const { assertApprovalDigest } = require('./approval')
const { loadApprovedPlan } = require('./approval-artifacts')

const { runBasicReporting } = require('./scenarios/basic-reporting')
const { runEarlyFlakeDetection } = require('./scenarios/early-flake-detection')
const { runAutoTestRetries } = require('./scenarios/auto-test-retries')
const { runTestManagement } = require('./scenarios/test-management')
const { runCiWiring } = require('./scenarios/ci-wiring')
const { cleanupGeneratedFiles } = require('./generated-files')
const { verifyGeneratedTestStrategy } = require('./generated-verifier')
const { annotateCiDiscovery } = require('./ci-discovery')
const { loadManifest } = require('./manifest-loader')
const { createManifestScaffold } = require('./manifest-scaffold')
const {
  formatExecutionPlanArtifacts,
  getExecutionPlanPath,
} = require('./plan-writer')
const { runFrameworkPreflight } = require('./preflight-runner')
const { sanitizeConsoleText } = require('./redaction')
const { annotateResults, getExecutionStatus, getValidatorExitCode } = require('./result-semantics')
const { writePendingReport, writeReport } = require('./report-writer')
const { ensureSafeDirectory } = require('./safe-files')
const {
  getStaticBlocker,
  runStaticDiagnosis,
} = require('./static-diagnosis')

const DEFAULT_MANIFEST = './dd-test-optimization-validation-manifest.json'
const DEFAULT_OUT = './dd-test-optimization-validation-results'

const SCENARIOS = {
  'basic-reporting': runBasicReporting,
  efd: runEarlyFlakeDetection,
  atr: runAutoTestRetries,
  'test-management': runTestManagement,
}
const BASIC_REPORTING_SCENARIO = 'basic-reporting'
const CI_WIRING_SCENARIO = 'ci-wiring'

function parseArgs (argv) {
  const options = {
    manifest: DEFAULT_MANIFEST,
    out: DEFAULT_OUT,
    frameworks: new Set(),
    scenarios: new Set(getSelectableScenarios()),
    requestedScenario: null,
    keepTempFiles: false,
    verbose: false,
    approvalOverrides: [],
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--manifest':
        options.manifest = requireValue(argv, ++i, arg)
        options.approvalOverrides.push(arg)
        break
      case '--out':
        options.out = requireValue(argv, ++i, arg)
        options.approvalOverrides.push(arg)
        break
      case '--framework':
        options.frameworks.add(normalizeFrameworkTarget(requireValue(argv, ++i, arg)))
        options.approvalOverrides.push(arg)
        break
      case '--scenario':
        options.requestedScenario = requireValue(argv, ++i, arg)
        options.scenarios = normalizeScenarioSelection(options.requestedScenario)
        options.approvalOverrides.push(arg)
        break
      case '--keep-temp-files':
        options.keepTempFiles = true
        options.approvalOverrides.push(arg)
        break
      case '--verbose':
        options.verbose = true
        options.approvalOverrides.push(arg)
        break
      case '--validate-manifest':
        options.validateManifest = true
        break
      case '--init-manifest':
        options.initManifest = true
        break
      case '--print-plan':
        options.printPlan = true
        break
      case '--run-approved-plan':
        options.runApprovedPlan = requireValue(argv, ++i, arg)
        break
      case '--sha256':
        options.approvedArtifactSha256 = requireValue(argv, ++i, arg)
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  for (const scenario of options.scenarios) {
    if (!getSelectableScenarios().includes(scenario)) {
      throw new Error(`Unknown scenario "${scenario}". Expected one of: ${getSelectableScenarios().join(', ')}`)
    }
  }

  return options
}

function requireValue (argv, index, flag) {
  if (!argv[index]) {
    throw new Error(`${flag} requires a value`)
  }
  return argv[index]
}

function printHelp () {
  console.log(`Usage:
  node ci/validate-test-optimization.js [options]

Options:
  --manifest <path>       Manifest path. Defaults to ${DEFAULT_MANIFEST}
  --out <path>            Output directory. Defaults to ${DEFAULT_OUT}
  --framework <id>        Run one framework entry. Can be repeated. A trailing ":" is ignored.
                          A framework kind such as "vitest" runs all matching Vitest entries.
  --scenario <name>       Run one scenario: ${getSelectableScenarios().join(', ')}
  --keep-temp-files       Leave generated validation files in place.
  --verbose               Print command progress.
  --validate-manifest     Validate the manifest and exit without running project code.
  --init-manifest         Create a schema-valid manifest scaffold without running project code.
  --print-plan            Write the plan and approval artifacts without running project code.
  --run-approved-plan     Run the exact approval.json produced by --print-plan.
  --sha256 <digest>       Require approval.json and reconstructed current inputs to match this SHA-256.
  --help                  Show this help.
`)
}

async function main (argv) {
  let activeManifest
  let activeOut
  try {
    const options = parseArgs(argv)
    assertCompatibleModes(options)
    if (options.help) {
      printHelp()
      return
    }

    if (options.initManifest) {
      const manifestPath = path.resolve(options.manifest)
      if (path.dirname(manifestPath) !== process.cwd()) {
        throw new Error('The generated manifest must be stored directly in the current repository root.')
      }
      const manifest = createManifestScaffold({ root: process.cwd(), frameworks: options.frameworks })
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
      const reviewTargets = manifest.ciDiscovery?.reviewTargets || []
      const reviewRequired = manifest.ciDiscovery?.reviewRequired !== false
      const initializationStatus = manifest.frameworks.find(framework => framework.status === 'runnable')
        ?.ciWiring?.initialization?.status
      const nextStep = reviewRequired
        ? 'Inspect only the CI review targets in order and stop after the first matching test job. Preserve the ' +
          'scaffold commands and temporary tests. Then run --validate-manifest and --print-plan.'
        : 'The bounded scan found no dd-trace/ci/init preload in any discovered CI configuration. That static ' +
          'conclusion is complete. Do not open or edit the manifest and do not inspect project files. Run the ' +
          'following command next:\n' +
          'node ./node_modules/dd-trace/ci/validate-test-optimization.js ' +
          '--manifest ./dd-test-optimization-validation-manifest.json ' +
          '--out ./dd-test-optimization-validation-results --print-plan'
      console.log(sanitizeConsoleText([
        `Created a schema-valid validation manifest without running project code: ${manifestPath}`,
        'The scaffold selected bounded test candidates and validator-owned temporary tests. Do not enumerate ' +
          'other packages, tests, runner configs, workflow files, or manifest fields.',
        `CI review targets: ${reviewTargets.length > 0 ? reviewTargets.join(', ') : '<none found>'}.`,
        `CI initialization status: ${initializationStatus || 'unknown'}. Allowed values are configured, ` +
          'not_configured, and unknown.',
        nextStep,
      ].join('\n')))
      return
    }

    if (options.runApprovedPlan) applyApprovedPlanOptions(options)

    const manifest = loadManifest(options.manifest)
    if (options.printPlan) {
      const out = validateOutputPath(manifest, options.out)
      const approvalManifest = getApprovalManifest(manifest, options.frameworks)
      const { plan } = formatExecutionPlanArtifacts({
        manifest: approvalManifest,
        out,
        selectedFrameworkIds: options.frameworks.size > 0
          ? approvalManifest.frameworks.map(framework => framework.id)
          : [],
        requestedScenario: options.requestedScenario,
        keepTempFiles: options.keepTempFiles,
        verbose: options.verbose,
      })
      console.log(sanitizeConsoleText([
        '===== CUSTOMER APPROVAL PLAN =====',
        plan,
        '===== END CUSTOMER APPROVAL PLAN =====',
        '',
        `Saved execution plan: ${getExecutionPlanPath(out)}`,
        '',
        'LIVE VALIDATION HAS NOT RUN.',
        'DISCOVERY IS COMPLETE. STOP TOOL USE NOW.',
        'AGENT RESPONSE REQUIRED: Tool output is not the next user-facing response, even when it is visible in the ' +
          'agent terminal. Your next response must begin with ===== CUSTOMER APPROVAL PLAN =====, reproduce the ' +
          'complete delimited block above, and end with: Approve executing exactly the plan above?',
        'A response containing only "Awaiting approval", "Approve the plan above", a prose summary, or a link to ' +
          'the saved plan is invalid. Do not continue discovery or run another command while waiting.',
      ].join('\n')))
      return
    }
    if (options.validateManifest) {
      console.log(sanitizeConsoleText(`Validation manifest is valid: ${manifest.__path}`))
      return
    }
    if (!options.approvedPlanSha256 || !options.offlineFixtureNonce) {
      throw new Error(
        'Live validation requires --run-approved-plan and --sha256 from a reviewed --print-plan result. Render and ' +
        'approve a fresh execution plan first.'
      )
    }
    const out = validateOutputPath(manifest, options.out)
    activeManifest = manifest
    activeOut = out
    options.repositoryRoot = manifest.repository.root
    const selectedFrameworks = filterFrameworks(manifest.frameworks, options.frameworks)
    const approvalManifest = getApprovalManifest(manifest, options.frameworks)
    assertApprovalDigest(options.approvedPlanSha256, {
      manifest: approvalManifest,
      out,
      selectedFrameworkIds: options.frameworks.size > 0
        ? selectedFrameworks.map(framework => framework.id)
        : [],
      requestedScenario: options.requestedScenario,
      offlineFixtureNonce: options.offlineFixtureNonce,
      keepTempFiles: options.keepTempFiles,
      verbose: options.verbose,
    })
    options.requireExecutableApproval = true
    ensureSafeDirectory(manifest.repository.root, out, 'validation output directory', { allowRootSymlink: true })
    if (writePendingReport) writePendingReport({ manifest, out })
    const staticDiagnosis = runStaticDiagnosis({ manifest, out })
    annotateCiDiscovery({ manifest, diagnosis: staticDiagnosis.report })

    const results = []
    const runnableFrameworks = []

    try {
      const frameworks = filterFrameworks(manifest.frameworks, options.frameworks)
      const liveReadyFrameworks = []

      for (const framework of frameworks) {
        if (framework.status !== 'runnable') {
          results.push(getFrameworkStatusResult(framework))
          continue
        }

        const staticBlocker = getStaticBlocker(framework, staticDiagnosis.report)
        if (staticBlocker) {
          results.push(getStaticFailure(framework, staticBlocker, staticDiagnosis.reportPath))
          continue
        }

        liveReadyFrameworks.push(framework)
      }

      runnableFrameworks.push(...liveReadyFrameworks)
      for (const framework of runnableFrameworks) {
        let basicResult
        if (options.scenarios.has(BASIC_REPORTING_SCENARIO)) {
          // The validator owns the dd-trace-less control so ambient agent initialization cannot contaminate it.
          logPhaseStart(framework, 'Test execution without Datadog')
          // eslint-disable-next-line no-await-in-loop
          const preflight = await runFrameworkPreflight({ framework, out, options })
          logPhaseComplete(
            framework,
            'Test execution without Datadog',
            preflight.ok ? 'pass' : preflight.failure?.status
          )
          // Scenarios intentionally run in order so each one can use an isolated offline fixture.
          if (preflight.ok) {
            logPhaseStart(framework, 'Basic Reporting')
            // eslint-disable-next-line no-await-in-loop
            basicResult = await SCENARIOS[BASIC_REPORTING_SCENARIO]({ manifest, framework, out, options })
            logPhaseComplete(framework, 'Basic Reporting', basicResult.status)
          } else {
            basicResult = preflight.failure
          }
          results.push(basicResult)
        }

        if (options.scenarios.has(CI_WIRING_SCENARIO)) {
          logPhaseStart(framework, 'CI configuration audit')
          // eslint-disable-next-line no-await-in-loop
          const ciWiringResult = await runCiWiring({ manifest, framework, out, options, basicResult })
          results.push(ciWiringResult)
          logPhaseComplete(framework, 'CI configuration audit', ciWiringResult.status)
        }

        const advancedScenarios = getAdvancedScenarios(options.scenarios)
        if (basicResult && basicResult.status !== 'pass') {
          for (const scenario of advancedScenarios) {
            results.push(getSkippedAfterBasicFailure(framework, scenario, basicResult))
          }
          continue
        }

        if (advancedScenarios.length > 0) {
          logPhaseStart(framework, 'Temporary test verification')
          // eslint-disable-next-line no-await-in-loop
          const generatedVerification = await verifyGeneratedTestStrategy({ framework, out, options })
          logPhaseComplete(
            framework,
            'Temporary test verification',
            generatedVerification.ok ? 'pass' : generatedVerification.failure?.status
          )
          if (!generatedVerification.ok) {
            results.push(generatedVerification.failure)
            for (const scenario of advancedScenarios) {
              results.push(getSkippedAfterGeneratedVerificationFailure(
                framework,
                scenario,
                generatedVerification.failure
              ))
            }
            continue
          }
        }

        for (const scenario of advancedScenarios) {
          const runScenario = SCENARIOS[scenario]
          // Scenarios intentionally run in order so each one can use an isolated offline fixture.
          logPhaseStart(framework, getScenarioDisplayName(scenario))
          // eslint-disable-next-line no-await-in-loop
          const result = await runScenario({ manifest, framework, out, options })
          results.push(result)
          logPhaseComplete(framework, getScenarioDisplayName(scenario), result.status)
        }
      }
    } finally {
      try {
        await cleanupGeneratedFiles(manifest, { keep: options.keepTempFiles })
      } catch (error) {
        results.push(getValidationCleanupFailure('temporary validation files', error))
      }
    }

    addMissingRequiredResults(results, runnableFrameworks, options.scenarios)
    const annotatedResults = annotateResults(results)
    const executionStatus = getExecutionStatus(annotatedResults)
    const validatorExitCode = getValidatorExitCode(annotatedResults, executionStatus)
    await writeReport({
      manifest,
      results: annotatedResults,
      out,
      staticDiagnosis,
      runSummary: {
        runCompleted: true,
        executionStatus,
        validatorExitCode,
        validationCoverage: getValidationCoverage({
          results,
          requestedScenario: options.requestedScenario,
          frameworks: selectedFrameworks,
          scenarios: options.scenarios,
        }),
        checkedScenarios: [...options.scenarios],
        omittedScenarios: getSelectableScenarios().filter(scenario => !options.scenarios.has(scenario)),
        requestedScenario: options.requestedScenario,
        selectedFrameworkIds: selectedFrameworks.map(framework => framework.id),
      },
    })
    process.exitCode = validatorExitCode
  } catch (err) {
    process.exitCode = 3
    if (activeManifest && activeOut) {
      try {
        await writeReport({
          manifest: activeManifest,
          results: [{
            frameworkId: 'validator',
            scenario: 'all',
            status: 'error',
            diagnosis: err?.message || String(err),
            evidence: { validationIncomplete: true, validationOrchestrationFailed: true },
            artifacts: [],
          }],
          out: activeOut,
          runSummary: {
            runCompleted: true,
            executionStatus: 'validator_error',
            validatorExitCode: 3,
            validationCoverage: 'partial',
            checkedScenarios: [],
            omittedScenarios: getSelectableScenarios(),
            selectedFrameworkIds: [],
          },
        })
      } catch {}
    }
    console.error(sanitizeConsoleText(err && err.stack ? err.stack : err))
  }
}

/**
 * Prevents a reviewed live-run artifact from being combined with a print-only mode.
 *
 * @param {object} options parsed CLI options
 * @returns {void}
 */
function assertCompatibleModes (options) {
  if (!options.runApprovedPlan) return
  const incompatible = [
    ['--help', options.help],
    ['--init-manifest', options.initManifest],
    ['--print-plan', options.printPlan],
    ['--validate-manifest', options.validateManifest],
  ].find(([, enabled]) => enabled)
  if (incompatible) {
    throw new Error(`--run-approved-plan cannot be combined with ${incompatible[0]}.`)
  }
}

/**
 * Creates a fail-closed result when validation-owned cleanup cannot be completed safely.
 *
 * @param {string} target customer-facing cleanup target
 * @param {Error} error cleanup error
 * @param {object} [framework] affected framework
 * @returns {object} validation error result
 */
function getValidationCleanupFailure (target, error, framework) {
  return {
    frameworkId: framework?.id || 'validation-cleanup',
    scenario: 'all',
    status: 'error',
    diagnosis: `The validator could not safely remove ${target}. Review the local artifacts before rerunning.`,
    evidence: {
      validationIncomplete: true,
      cleanupFailed: true,
      error: error?.message || String(error),
    },
    artifacts: [],
  }
}

/**
 * Reconstructs live options from a hash-verified approval artifact.
 *
 * @param {object} options parsed CLI options
 * @returns {void}
 */
function applyApprovedPlanOptions (options) {
  if (!options.approvedArtifactSha256) {
    throw new Error('--run-approved-plan requires --sha256 from the reviewed execution plan.')
  }
  if (options.approvalOverrides.length > 0) {
    throw new Error('--run-approved-plan cannot be combined with manifest, output, or selection flags.')
  }

  const { material } = loadApprovedPlan(options.runApprovedPlan, options.approvedArtifactSha256)
  options.manifest = material.manifest.path
  options.out = material.validation.outputDirectory
  options.frameworks = new Set(material.selection.frameworks.map(normalizeFrameworkTarget))
  options.requestedScenario = material.selection.scenario
  options.scenarios = options.requestedScenario
    ? normalizeScenarioSelection(options.requestedScenario)
    : new Set(getSelectableScenarios())
  options.offlineFixtureNonce = material.validation.offlineFixtureNonce
  options.keepTempFiles = material.validation.keepTemporaryFiles === true
  options.verbose = material.validation.verbose === true
  options.approvedPlanSha256 = options.approvedArtifactSha256
}

function validateOutputPath (manifest, outputPath) {
  const root = path.resolve(manifest.repository.root)
  const out = path.resolve(outputPath)
  const relative = path.relative(root, out)
  if (relative === '' || !relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Validation output directory must be a dedicated child directory inside repository.root.')
  }
  return out
}

function filterFrameworks (frameworks, targets) {
  if (targets.size === 0) return frameworks

  const selected = frameworks.filter(framework => {
    return targets.has(framework.id) || targets.has(framework.framework)
  })

  if (selected.length === 0) {
    throw new Error(`No framework entries matched ${formatFrameworkTargets(targets)}. Available entries: ${
      frameworks.map(framework => framework.id).join(', ') || 'none'
    }`)
  }

  return selected
}

/**
 * Creates the manifest view covered by a framework-scoped approval.
 *
 * @param {object} manifest loaded manifest
 * @param {Set<string>} targets selected framework targets
 * @returns {object} approval manifest
 */
function getApprovalManifest (manifest, targets) {
  const frameworks = filterFrameworks(manifest.frameworks, targets)
  if (frameworks === manifest.frameworks) return manifest

  const approvalManifest = { ...manifest, frameworks }
  Object.defineProperty(approvalManifest, '__sourceSha256', {
    configurable: false,
    enumerable: false,
    value: manifest.__sourceSha256,
    writable: false,
  })
  return approvalManifest
}

function normalizeFrameworkTarget (target) {
  const normalized = String(target).trim().replaceAll(/:+$/g, '')
  if (!normalized) {
    throw new Error('Framework target cannot be empty')
  }
  return normalized
}

function formatFrameworkTargets (targets) {
  return [...targets].map(target => `"${target}"`).join(', ')
}

function normalizeScenarioSelection (scenario) {
  if (scenario === BASIC_REPORTING_SCENARIO) return new Set([scenario])
  return new Set([BASIC_REPORTING_SCENARIO, scenario])
}

function getAdvancedScenarios (scenarios) {
  return Object.keys(SCENARIOS).filter(scenario => {
    return scenario !== BASIC_REPORTING_SCENARIO && scenarios.has(scenario)
  })
}

/**
 * Fails closed when orchestration omits a selected check for a runnable framework.
 *
 * @param {object[]} results collected validation results
 * @param {object[]} frameworks runnable frameworks whose live phases started
 * @param {Set<string>} scenarios selected scenarios
 * @returns {void}
 */
function addMissingRequiredResults (results, frameworks, scenarios) {
  for (const framework of frameworks) {
    for (const scenario of scenarios) {
      if (results.some(result => result.frameworkId === framework.id && result.scenario === scenario)) continue
      results.push({
        frameworkId: framework.id,
        scenario,
        status: 'error',
        diagnosis: `${getScenarioDisplayName(scenario)} was selected but produced no validation result.`,
        evidence: {
          validationIncomplete: true,
          recommendation: 'Rerun the validator. If the check remains absent, report this validator orchestration ' +
            'error instead of treating the validation as successful.',
        },
        artifacts: [],
      })
    }
  }
}

/**
 * Reports whether all default checks produced results in an unscoped run.
 *
 * @param {object} input coverage inputs
 * @param {object[]} input.results validation results
 * @param {string|null} input.requestedScenario explicitly selected scenario
 * @param {object[]} input.frameworks selected manifest frameworks
 * @param {Set<string>} input.scenarios selected scenarios
 * @returns {'complete'|'partial'} validation coverage
 */
function getValidationCoverage ({ results, requestedScenario, frameworks, scenarios }) {
  if (requestedScenario) return 'partial'
  if (results.some(result => result.evidence?.manifestIncomplete || result.evidence?.validationIncomplete)) {
    return 'partial'
  }

  const runnableFrameworks = frameworks.filter(framework => framework.status === 'runnable')
  if (runnableFrameworks.length === 0) return 'partial'
  for (const framework of runnableFrameworks) {
    for (const scenario of scenarios) {
      if (!results.some(result => result.frameworkId === framework.id && result.scenario === scenario)) {
        return 'partial'
      }
      const result = results.find(result => result.frameworkId === framework.id && result.scenario === scenario)
      if (!['pass', 'fail'].includes(result.status) || result.evidence?.validationIncomplete === true) {
        return 'partial'
      }
    }
  }
  return 'complete'
}

function getSelectableScenarios () {
  return [
    BASIC_REPORTING_SCENARIO,
    CI_WIRING_SCENARIO,
    ...Object.keys(SCENARIOS).filter(scenario => scenario !== BASIC_REPORTING_SCENARIO),
  ]
}

function getSkippedAfterBasicFailure (framework, scenario, basicResult) {
  return {
    frameworkId: framework.id,
    scenario,
    status: 'skip',
    diagnosis: `Skipped because basic reporting did not pass: ${basicResult.diagnosis}`,
    evidence: {
      blockedBy: BASIC_REPORTING_SCENARIO,
      basicReportingStatus: basicResult.status,
      basicReportingDiagnosis: basicResult.diagnosis,
      featureEligibility: {
        eligible: false,
        blockedBy: BASIC_REPORTING_SCENARIO,
        reasonCode: 'basic-reporting-failed',
        scenario,
      },
    },
    artifacts: [],
  }
}

function getSkippedAfterGeneratedVerificationFailure (framework, scenario, failure) {
  return {
    frameworkId: framework.id,
    scenario,
    status: 'skip',
    diagnosis: `Skipped because the temporary validation test could not run as expected: ${failure.diagnosis}`,
    evidence: {
      conclusion: 'incomplete',
      domain: 'validator_adapter',
      evidenceStrength: 'confirmed_runtime',
      blockedBy: 'generated-test-verification',
      verificationStatus: failure.status,
      verificationDiagnosis: failure.diagnosis,
      featureEligibility: {
        eligible: false,
        blockedBy: 'generated-test-verification',
        reasonCode: 'generated-test-verification-failed',
        scenario,
      },
    },
    artifacts: [],
  }
}

/**
 * Prints the start of one framework validation phase.
 *
 * @param {object} framework manifest framework entry
 * @param {string} phase customer-facing phase name
 * @returns {void}
 */
function logPhaseStart (framework, phase) {
  logValidationProgress(`${framework.id}: ${phase} started.`)
}

/**
 * Prints the outcome of one framework validation phase.
 *
 * @param {object} framework manifest framework entry
 * @param {string} phase customer-facing phase name
 * @param {string|undefined} status phase outcome
 * @returns {void}
 */
function logPhaseComplete (framework, phase, status) {
  logValidationProgress(`${framework.id}: ${phase} ${status || 'complete'}.`)
}

/**
 * Prints a sanitized validator progress line.
 *
 * @param {string} message progress message
 * @returns {void}
 */
function logValidationProgress (message) {
  console.log(sanitizeConsoleText(`[test-optimization-validator] ${message}`))
}

/**
 * Converts an advanced scenario id to customer-facing text.
 *
 * @param {string} scenario scenario id
 * @returns {string} display name
 */
function getScenarioDisplayName (scenario) {
  return {
    'basic-reporting': 'Basic Reporting',
    'ci-wiring': 'CI Configuration Audit',
    efd: 'Early Flake Detection',
    atr: 'Auto Test Retries',
    'test-management': 'Test Management',
  }[scenario] || scenario
}

function getStaticFailure (framework, blocker, staticDiagnosisPath) {
  return {
    frameworkId: framework.id,
    scenario: 'all',
    status: 'fail',
    diagnosis: blocker.reason,
    evidence: {
      staticDiagnosis: true,
      recommendation: blocker.recommendation,
    },
    artifacts: [staticDiagnosisPath],
  }
}

function getFrameworkStatusResult (framework) {
  const evidence = getFrameworkStatusEvidence(framework)

  if (framework.supportLevel === 'dd_trace_supported_but_validator_missing_adapter') {
    const frameworkName = getDisplayFrameworkName(framework.framework)
    return {
      frameworkId: framework.id,
      scenario: 'all',
      status: 'skip',
      diagnosis: `${frameworkName} was detected and is supported by dd-trace, but this local validator does not ` +
        `yet provide a live ${frameworkName} adapter. No project test command was run.`,
      evidence: {
        ...evidence,
        validatorAdapterUnavailable: true,
        recommendation: 'Use the static diagnostic evidence for this framework. Live local validation currently ' +
          'supports Jest, Mocha, and Vitest.',
      },
      artifacts: [],
    }
  }

  if (framework.status === 'unsupported_by_validator') {
    const frameworkName = getDisplayFrameworkName(framework.framework)

    return {
      frameworkId: framework.id,
      scenario: 'all',
      status: 'skip',
      diagnosis: `${frameworkName} is not supported as a Test Optimization test framework.`,
      evidence: {
        ...evidence,
        recommendation: 'Choose a supported framework before running live validation.',
      },
      artifacts: [],
    }
  }

  return {
    frameworkId: framework.id,
    scenario: 'all',
    status: 'skip',
    diagnosis: getFrameworkStatusDiagnosis(framework, evidence),
    evidence: {
      ...evidence,
      recommendation: 'Provide a small runnable command for this framework, or mark the setup blocker explicitly.',
    },
    artifacts: [],
  }
}

function getFrameworkStatusDiagnosis (framework, evidence) {
  const frameworkName = framework.framework
  const notes = evidence.manifestNotes || []

  if (isDependencyOnlyDetection(evidence)) {
    return getDependencyOnlyDiagnosis(framework, evidence)
  }

  if (notes.length > 0) {
    return `${frameworkName} was detected, but no runnable validation command was available. ` +
      `Basic reporting was not run. Manifest reason: ${notes[0]}`
  }

  return `${frameworkName} was detected, but the manifest did not prove a runnable validation command. ` +
    'Basic reporting was not run. See discovery evidence for scripts/config files to turn into a small command.'
}

function isDependencyOnlyDetection (evidence) {
  return evidence.directDependency && evidence.configFiles.length === 0 && evidence.frameworkScripts.length === 0
}

function getDependencyOnlyDiagnosis (framework, evidence) {
  const frameworkName = getDisplayFrameworkName(framework.framework)
  const dependency = formatDependency(evidence.directDependency)
  const note = evidence.manifestNotes?.[0] ? ` Manifest note: ${evidence.manifestNotes[0]}` : ''
  const common = `${frameworkName} is installed${dependency}, but this repository does not appear to use ` +
    `${frameworkName} to run tests: no ${framework.framework} config, package script, or runnable ` +
    `${framework.framework} test command was found. Basic reporting was not run for ${frameworkName}.`

  if (framework.framework === 'playwright') {
    return `${frameworkName} is installed${dependency}, but no Playwright Test setup was found. ` +
      'The playwright package can be used only for browser automation; Test Optimization validation needs a ' +
      '`playwright test` setup with a config, script, or runnable test command. Basic reporting was not run ' +
      `for ${frameworkName}.${note}`
  }

  return `${common} If this repo does use ${frameworkName}, provide a small ${frameworkName} test command; ` +
    `otherwise this dependency-only detection can be ignored.${note}`
}

function getDisplayFrameworkName (frameworkName) {
  return {
    cucumber: 'Cucumber',
    cypress: 'Cypress',
    jest: 'Jest',
    mocha: 'Mocha',
    playwright: 'Playwright',
    vitest: 'Vitest',
  }[frameworkName] || frameworkName
}

function formatDependency (dependency) {
  if (!dependency) return ''
  return ` in ${dependency.field}${dependency.version ? ` (${dependency.version})` : ''}`
}

function getFrameworkStatusEvidence (framework) {
  const root = framework.project?.root
  return {
    frameworkStatus: framework.status,
    frameworkVersion: framework.frameworkVersion,
    supportLevel: framework.supportLevel,
    manifestNotes: Array.isArray(framework.notes) ? framework.notes : [],
    directDependency: root ? getDirectDependency(root, framework.framework) : undefined,
    frameworkScripts: root ? findFrameworkScripts(root, framework.framework) : [],
    testLikeScripts: root ? findTestLikeScripts(root) : [],
    configFiles: root ? findFrameworkConfigFiles(root, framework.framework) : [],
  }
}

function getDirectDependency (root, frameworkName) {
  const packageJson = readPackageJson(root)
  if (!packageJson) return

  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const value = packageJson[field]?.[frameworkName]
    if (value) return { field, version: value }
  }
}

function findFrameworkScripts (root, frameworkName) {
  return findScripts(root, (name, command) => {
    return includesWord(name, frameworkName) || includesWord(command, frameworkName)
  })
}

function findTestLikeScripts (root) {
  return findScripts(root, name => /(^|:)(test|unit|e2e|integration|ci)(:|$)/.test(name)).slice(0, 8)
}

function findScripts (root, predicate) {
  const packageJson = readPackageJson(root)
  const scripts = packageJson?.scripts || {}
  const matches = []
  for (const [name, command] of Object.entries(scripts)) {
    if (predicate(name, command)) matches.push({ name, command })
  }
  return matches.slice(0, 8)
}

function findFrameworkConfigFiles (root, frameworkName) {
  const patterns = getFrameworkConfigPatterns(frameworkName)
  if (patterns.length === 0) return []

  const files = []
  findFiles(root, 4, file => {
    if (patterns.some(pattern => pattern.test(path.basename(file)))) {
      files.push(path.relative(root, file))
    }
    return files.length < 8
  })
  return files
}

function getFrameworkConfigPatterns (frameworkName) {
  const definition = getFrameworkDefinitions(DD_MAJOR).find(definition => definition.id === frameworkName)
  return definition?.configPatterns || []
}

function readPackageJson (root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

function findFiles (dir, depth, visit) {
  if (depth < 0) return true

  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return true
  }

  for (const entry of entries) {
    if (shouldSkipDirectory(entry.name)) continue
    const filename = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!findFiles(filename, depth - 1, visit)) return false
    } else if (!visit(filename)) {
      return false
    }
  }

  return true
}

function shouldSkipDirectory (name) {
  return name === '.git' || name === 'node_modules' || name === 'dist' || name === 'coverage'
}

function includesWord (value, word) {
  return new RegExp(`(^|[^a-zA-Z0-9_-])${escapeRegExp(word)}([^a-zA-Z0-9_-]|$)`).test(value)
}

function escapeRegExp (value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

module.exports = { filterFrameworks, main, normalizeFrameworkTarget, parseArgs }
