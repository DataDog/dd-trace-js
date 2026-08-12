'use strict'

/* eslint-disable no-console */

const fs = require('node:fs')
const path = require('node:path')

const { assertApprovalDigest, getApprovalProjectSnapshot } = require('./approval')
const { loadApprovedPlan } = require('./approval-artifacts')
const { BLOCKER_CATEGORIES, getBlockerDomain } = require('./blocker-category')
const { annotateCiDiscovery } = require('./ci-discovery')
const { cleanupGeneratedFiles } = require('./generated-files')
const { verifyGeneratedTestStrategy } = require('./generated-verifier')
const {
  acquireExecutionLock,
  releaseExecutionLock,
} = require('./execution-lock')
const { loadManifest } = require('./manifest-loader')
const { createManifestScaffold } = require('./manifest-scaffold')
const {
  formatExecutionPlanArtifacts,
  getExecutionPlanPath,
} = require('./plan-writer')
const { checkInstalledPackage, getInstalledPackageFailure } = require('./package-check')
const { runFrameworkPreflight } = require('./preflight-runner')
const { sanitizeConsoleText } = require('./redaction')
const {
  annotateResults,
  getExecutionStatus,
  getValidationCoverage,
  getValidatorExitCode,
} = require('./result-semantics')
const { writePendingReport, writeReport } = require('./report-writer')
const { getBasicCommand } = require('./runner-command')
const { getUnavailableExecutable } = require('./executable')
const { runAutoTestRetries } = require('./scenarios/auto-test-retries')
const { runBasicReporting } = require('./scenarios/basic-reporting')
const { runCiWiring } = require('./scenarios/ci-wiring')
const { runEarlyFlakeDetection } = require('./scenarios/early-flake-detection')
const { runTestManagement } = require('./scenarios/test-management')
const { ensureSafeDirectory } = require('./safe-files')
const { getStaticBlocker, runStaticDiagnosis } = require('./static-diagnosis')
const { getValidationBlockerEvidence } = require('./validation-blocker')

const DEFAULT_MANIFEST = './dd-test-optimization-validation-manifest.json'
const DEFAULT_OUT = './dd-test-optimization-validation-results'
const SCENARIOS = {
  'basic-reporting': runBasicReporting,
  efd: runEarlyFlakeDetection,
  atr: runAutoTestRetries,
  'test-management': runTestManagement,
}
const BASIC_REPORTING = 'basic-reporting'
const CI_WIRING = 'ci-wiring'

/**
 * Parses validator CLI arguments.
 *
 * @param {string[]} argv command arguments
 * @returns {object} parsed options
 */
function parseArgs (argv) {
  const options = {
    approvalOverrides: [],
    frameworks: new Set(),
    keepTempFiles: false,
    manifest: DEFAULT_MANIFEST,
    out: DEFAULT_OUT,
    requestedScenario: null,
    scenarios: new Set(getSelectableScenarios()),
    verbose: false,
  }

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--manifest') {
      options.manifest = requireValue(argv, ++index, argument)
      options.approvalOverrides.push(argument)
    } else if (argument === '--out') {
      options.out = requireValue(argv, ++index, argument)
      options.approvalOverrides.push(argument)
    } else if (argument === '--framework') {
      options.frameworks.add(normalizeFrameworkTarget(requireValue(argv, ++index, argument)))
      options.approvalOverrides.push(argument)
    } else if (argument === '--scenario') {
      options.requestedScenario = requireValue(argv, ++index, argument)
      options.scenarios = normalizeScenarioSelection(options.requestedScenario)
      options.approvalOverrides.push(argument)
    } else if (argument === '--keep-temp-files') {
      options.keepTempFiles = true
      options.approvalOverrides.push(argument)
    } else if (argument === '--verbose') {
      options.verbose = true
      options.approvalOverrides.push(argument)
    } else if (argument === '--validate-manifest') {
      options.validateManifest = true
    } else if (argument === '--init-manifest') {
      options.initManifest = true
    } else if (argument === '--print-plan') {
      options.printPlan = true
    } else if (argument === '--run-approved-plan') {
      options.runApprovedPlan = requireValue(argv, ++index, argument)
    } else if (argument === '--sha256') {
      options.approvedArtifactSha256 = requireValue(argv, ++index, argument)
    } else if (argument === '--help' || argument === '-h') {
      options.help = true
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return options
}

/**
 * Runs the validator CLI.
 *
 * @param {string[]} argv command arguments
 * @returns {Promise<void>} completion
 */
async function main (argv) {
  let activeApprovedPlanSha256
  let activeManifest
  let activeOut
  let cleanupOutcome = { status: 'not_started' }
  let executionLock

  try {
    const options = parseArgs(argv)
    assertCompatibleModes(options)
    if (options.help) return printHelp()
    if (options.initManifest) return initializeManifest(options)

    if (options.runApprovedPlan) applyApprovedPlanOptions(options)
    const manifest = loadManifest(options.manifest)

    if (options.validateManifest) {
      console.log(sanitizeConsoleText(`Validation manifest is valid: ${manifest.__path}`))
      return
    }
    if (options.printPlan) return printPlan(manifest, options)
    if (!options.approvedPlanSha256 || !options.offlineFixtureNonce) {
      throw new Error('Live validation requires the checksum-bound command produced by --print-plan.')
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
    activeApprovedPlanSha256 = options.approvedPlanSha256
    const packageCheck = hasLocalScenarios(options.scenarios)
      ? checkInstalledPackage()
      : undefined
    options.requireExecutableApproval = true
    ensureSafeDirectory(manifest.repository.root, out, 'validation output directory', { allowRootSymlink: true })
    executionLock = acquireExecutionLock({
      out,
      approvedPlanSha256: options.approvedPlanSha256,
    })
    writePendingReport({ manifest, out })

    const staticDiagnosis = runStaticDiagnosis({ manifest, out })
    annotateCiDiscovery({ manifest, diagnosis: staticDiagnosis.report })
    const results = []

    try {
      for (const framework of selectedFrameworks) {
        // Each framework is independent. A setup blocker must not discard useful results from another adapter.
        // eslint-disable-next-line no-await-in-loop
        await validateFramework({ framework, manifest, options, out, packageCheck, results, staticDiagnosis })
      }
    } finally {
      try {
        cleanupOutcome = await cleanupGeneratedFiles(manifest, { keep: options.keepTempFiles })
        if (cleanupOutcome.status === 'incomplete') {
          results.push(getCleanupFailure(undefined, cleanupOutcome))
        }
      } catch (error) {
        cleanupOutcome = { errorCount: 1, status: 'incomplete' }
        results.push(getCleanupFailure(error, cleanupOutcome))
      }
    }

    addMissingResults(results, selectedFrameworks, options.scenarios)
    const annotatedResults = annotateResults(results)
    const executionStatus = getExecutionStatus(annotatedResults)
    const validatorExitCode = getValidatorExitCode(annotatedResults, executionStatus)
    await writeReport({
      manifest,
      out,
      results: annotatedResults,
      staticDiagnosis,
      runSummary: {
        approvedPlanSha256: activeApprovedPlanSha256,
        checkedScenarios: [...options.scenarios],
        cleanup: cleanupOutcome,
        executionStatus,
        omittedScenarios: getSelectableScenarios().filter(scenario => !options.scenarios.has(scenario)),
        requestedScenario: options.requestedScenario,
        runCompleted: true,
        selectedFrameworkIds: selectedFrameworks.map(framework => framework.id),
        validationCoverage: getValidationCoverage(annotatedResults),
        validatorExitCode,
      },
    })
    releaseExecutionLock(executionLock)
    executionLock = undefined
    console.log(`Validation report: ${path.join(out, 'report.md')}`)
    console.log('Present the report and stop. Any correction or retry requires a fresh plan and approval.')
    process.exitCode = validatorExitCode
  } catch (error) {
    let reportError = error
    if (executionLock) {
      await publishFailureReport({
        approvedPlanSha256: activeApprovedPlanSha256,
        cleanup: cleanupOutcome,
        error: reportError,
        manifest: activeManifest,
        out: activeOut,
      })
    }
    if (executionLock) {
      try {
        releaseExecutionLock(executionLock)
        executionLock = undefined
      } catch (releaseError) {
        reportError = releaseError
        await publishFailureReport({
          approvedPlanSha256: activeApprovedPlanSha256,
          cleanup: cleanupOutcome,
          error: reportError,
          manifest: activeManifest,
          out: activeOut,
        })
      }
    }
    const validatorExitCode = reportError?.validationExitCode || 3
    process.exitCode = validatorExitCode
    const blockerRecommendation = reportError?.validationBlocker?.recommendation
    const displayedError = reportError?.validationExitCode
      ? `${reportError.message}${blockerRecommendation ? ` ${blockerRecommendation}` : ''}`
      : (reportError?.stack || reportError)
    console.error(sanitizeConsoleText(displayedError))
  }
}

async function publishFailureReport ({ approvedPlanSha256, cleanup, error, manifest, out }) {
  if (!manifest || !out || error?.suppressReport) return
  try {
    await writeReport({
      manifest,
      out,
      results: [getOrchestrationFailure(error)],
      runSummary: {
        approvedPlanSha256,
        checkedScenarios: [],
        cleanup,
        executionStatus: error?.validationBlocker ? 'incomplete' : 'validator_error',
        omittedScenarios: getSelectableScenarios(),
        runCompleted: true,
        selectedFrameworkIds: [],
        validationCoverage: 'partial',
        validatorExitCode: error?.validationExitCode || 3,
      },
    })
  } catch {}
}

/**
 * Runs selected checks for one framework.
 *
 * @param {object} input framework execution inputs
 * @param {object} input.framework framework manifest entry
 * @param {object} input.manifest validation manifest
 * @param {object} input.options validator options
 * @param {string} input.out output directory
 * @param {object|undefined} input.packageCheck installed package-load result
 * @param {object[]} input.results accumulated results
 * @param {object} input.staticDiagnosis static diagnosis
 * @returns {Promise<void>} completion
 */
async function validateFramework ({ framework, manifest, options, out, packageCheck, results, staticDiagnosis }) {
  let ciResult
  if (options.scenarios.has(CI_WIRING)) {
    logPhase(framework, 'CI configuration audit', 'start')
    ciResult = runCiWiring({ manifest, framework })
    logPhase(framework, 'CI configuration audit', ciResult.status)
  }
  if (![...options.scenarios].some(scenario => scenario !== CI_WIRING)) {
    if (ciResult) results.push(ciResult)
    return
  }

  if (framework.status !== 'runnable') {
    results.push(getFrameworkStatusResult(framework))
    if (ciResult) results.push(ciResult)
    addNotReachedLocalResults(results, framework, options.scenarios, 'framework-not-runnable')
    return
  }

  if (packageCheck?.ok === false) {
    const packageFailure = getInstalledPackageFailure(framework, packageCheck)
    results.push(packageFailure)
    if (ciResult) results.push(ciResult)
    addAdvancedNotReached(results, framework, options.scenarios, packageFailure)
    return
  }

  const unavailable = getUnavailableExecutable(getBasicCommand(framework))
  if (unavailable) {
    const unavailableResult = getUnavailableRunnerResult(framework, unavailable)
    results.push(unavailableResult)
    if (ciResult) results.push(ciResult)
    addNotReachedLocalResults(
      results,
      framework,
      options.scenarios,
      'runner-unavailable',
      unavailableResult.evidence.blockerCategory
    )
    return
  }

  const blocker = getStaticBlocker(framework, staticDiagnosis.report)
  if (blocker) {
    const staticFailure = getStaticFailure(framework, blocker, staticDiagnosis.reportPath)
    const basicNotReached = getBasicNotReached(
      framework,
      blocker.reason,
      'static-project-blocker',
      blocker.blockerCategory
    )
    results.push(staticFailure, basicNotReached)
    if (ciResult) results.push(ciResult)
    addAdvancedNotReached(results, framework, options.scenarios, basicNotReached)
    return
  }

  let basicResult
  if (options.scenarios.has(BASIC_REPORTING)) {
    logPhase(framework, 'clean direct test', 'start')
    const preflight = await runFrameworkPreflight({ framework, out, options })
    logPhase(framework, 'clean direct test', preflight.ok ? 'pass' : 'incomplete')
    if (preflight.ok) {
      logPhase(framework, 'Basic Reporting', 'start')
      basicResult = await runBasicReporting({ manifest, framework, out, options })
      logPhase(framework, 'Basic Reporting', basicResult.status)
    } else {
      basicResult = preflight.failure
    }
    results.push(basicResult)
  }
  if (ciResult) results.push(ciResult)

  const advanced = getAdvancedScenarios(options.scenarios)
  if (advanced.length === 0) return
  if (basicResult?.evidence?.foundationalReportingEstablished !== true) {
    addAdvancedNotReached(results, framework, options.scenarios, basicResult)
    return
  }

  const generated = await verifyGeneratedTestStrategy({ framework, out, options })
  if (!generated.ok) {
    results.push(generated.failure)
    addAdvancedNotReached(results, framework, options.scenarios, generated.failure)
    return
  }
  for (const scenario of advanced) {
    // Advanced scenarios are serial because their offline fixtures and generated retry state are isolated.
    // eslint-disable-next-line no-await-in-loop
    results.push(await SCENARIOS[scenario]({ manifest, framework, out, options }))
  }
}

/**
 * Creates a manifest scaffold and prints the bounded next step.
 *
 * @param {object} options CLI options
 * @returns {void}
 */
function initializeManifest (options) {
  const manifestPath = path.resolve(options.manifest)
  if (path.dirname(manifestPath) !== process.cwd()) {
    throw new Error('The generated manifest must be stored directly in the current repository root.')
  }
  if (fs.existsSync(manifestPath)) return reuseExistingManifest(manifestPath)

  const manifest = createManifestScaffold({ root: process.cwd(), frameworks: options.frameworks })
  try {
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
  } catch (error) {
    if (error.code === 'EEXIST') return reuseExistingManifest(manifestPath)
    throw error
  }
  const targets = manifest.ciDiscovery.reviewTargets
  console.log(sanitizeConsoleText([
    `Created a data-only validation manifest: ${manifestPath}`,
    'No project code ran. The validator selected repository-contained runners and one test file per framework.',
    targets.length > 0
      ? `Review only these CI files, in order: ${targets.join(', ')}. Record one exact test job, command, and ` +
        'effective initialization/transport evidence. Set reviewComplete=true only after resolving wrappers and ' +
        'inherited configuration; otherwise leave the uncertainty in unresolved.'
      : 'No supported CI configuration file was found. Leave CI review incomplete.',
    'Do not add commands, setup steps, package scripts, wrapper chains, or fallback tests to the manifest.',
    'Then run --validate-manifest and --print-plan.',
  ].join('\n')))
}

/**
 * Writes and prints the approval plan.
 *
 * @param {object} manifest loaded manifest
 * @param {object} options CLI options
 * @returns {void}
 */
function printPlan (manifest, options) {
  const out = validateOutputPath(manifest, options.out)
  const approvalManifest = getApprovalManifest(manifest, options.frameworks)
  const localScenariosSelected = hasLocalScenarios(options.scenarios)
  if (!localScenariosSelected ||
    !approvalManifest.frameworks.some(framework => framework.status === 'runnable')) {
    return writeStaticOnlyReport(approvalManifest, out, options)
  }
  ensureSafeDirectory(manifest.repository.root, out, 'validation output directory', { allowRootSymlink: true })
  const publicationLock = acquireExecutionLock({ out, approvedPlanSha256: 'plan-publication' })
  try {
    const packageCheck = localScenariosSelected
      ? checkInstalledPackage()
      : undefined
    if (packageCheck?.ok === false) throw getInstalledPackageCheckError(packageCheck)

    const projectSnapshot = getApprovalProjectSnapshot(approvalManifest, {
      includeLocal: options.requestedScenario !== CI_WIRING,
    })
    const ciPreflightResults = options.scenarios.has(CI_WIRING)
      ? new Map(approvalManifest.frameworks.map(framework => [
        framework.id,
        runCiWiring({ manifest: approvalManifest, framework, projectFileSources: projectSnapshot.sources }),
      ]))
      : new Map()
    const { plan } = formatExecutionPlanArtifacts({
      manifest: approvalManifest,
      out,
      selectedFrameworkIds: options.frameworks.size > 0
        ? approvalManifest.frameworks.map(framework => framework.id)
        : [],
      requestedScenario: options.requestedScenario,
      keepTempFiles: options.keepTempFiles,
      packageCheck,
      ciPreflightResults,
      expectedProjectFiles: projectSnapshot.projectFiles,
      verbose: options.verbose,
    })
    console.log(sanitizeConsoleText([
      '===== CUSTOMER APPROVAL PLAN =====',
      plan,
      '===== END CUSTOMER APPROVAL PLAN =====',
      '',
      `Saved execution plan: ${getExecutionPlanPath(out)}`,
      'LIVE VALIDATION HAS NOT RUN.',
      'Present the complete delimited plan and ask exactly: Approve executing exactly the plan above?',
    ].join('\n')))
  } finally {
    releaseExecutionLock(publicationLock)
  }
}

function writeStaticOnlyReport (manifest, out, options) {
  const results = []
  const localScenariosSelected = hasLocalScenarios(options.scenarios)
  for (const framework of manifest.frameworks) {
    if (localScenariosSelected) {
      results.push(getFrameworkStatusResult(framework))
      addNotReachedLocalResults(results, framework, options.scenarios, 'framework-not-runnable')
    }
    if (options.scenarios.has(CI_WIRING)) results.push(runCiWiring({ manifest, framework }))
  }
  const annotatedResults = annotateResults(results)
  const executionStatus = getExecutionStatus(annotatedResults)
  const validatorExitCode = getValidatorExitCode(annotatedResults, executionStatus)
  ensureSafeDirectory(manifest.repository.root, out, 'validation output directory', { allowRootSymlink: true })
  const publicationLock = acquireExecutionLock({ out, approvedPlanSha256: 'static-only-report' })
  try {
    writeReport({
      manifest,
      out,
      results: annotatedResults,
      runSummary: {
        checkedScenarios: [...options.scenarios],
        cleanup: { directoriesRemoved: 0, filesRemoved: 0, status: 'completed' },
        executionStatus,
        omittedScenarios: getSelectableScenarios().filter(scenario => !options.scenarios.has(scenario)),
        requestedScenario: options.requestedScenario,
        runCompleted: true,
        selectedFrameworkIds: manifest.frameworks.map(framework => framework.id),
        validationCoverage: getValidationCoverage(annotatedResults),
        validatorExitCode,
      },
    })
  } finally {
    releaseExecutionLock(publicationLock)
  }
  const reason = localScenariosSelected
    ? 'No selected framework has an eligible local command.'
    : 'The selected CI-only audit does not require local execution.'
  console.log(sanitizeConsoleText(
    `${reason} A final static-only report was written; no new approval artifact or live validation command was ` +
    'created. Present the report and stop.'
  ))
  process.exitCode = validatorExitCode
}

function reuseExistingManifest (manifestPath) {
  try {
    const manifest = loadManifest(manifestPath)
    if (fs.realpathSync(manifest.repository.root) !== fs.realpathSync(process.cwd())) {
      throw new Error('repository.root does not identify the current physical repository')
    }
  } catch (error) {
    const recovery = new Error(
      `The existing validation manifest cannot be reused: ${error.message}. ` +
      `Inspect and remove only ${manifestPath}, then rerun --init-manifest. The validator did not delete or replace it.`
    )
    recovery.validationExitCode = 2
    throw recovery
  }

  console.log(sanitizeConsoleText([
    `Existing validation manifest is valid for this repository: ${manifestPath}`,
    'Reuse it, refresh only its ciWiring evidence if needed, then run --validate-manifest and --print-plan.',
    'The validator did not overwrite the manifest or delete existing approval and report artifacts.',
  ].join('\n')))
}

function hasLocalScenarios (scenarios) {
  return [...scenarios].some(scenario => scenario !== CI_WIRING)
}

function getInstalledPackageCheckError (packageCheck) {
  const error = new Error(
    `INSTALLED DD-TRACE PACKAGE BLOCKER: ${packageCheck.diagnosis} ${packageCheck.recommendation}`
  )
  error.validationExitCode = 2
  return error
}

/**
 * Restores approved execution options from approval.json.
 *
 * @param {object} options parsed options
 * @returns {void}
 */
function applyApprovedPlanOptions (options) {
  if (!options.approvedArtifactSha256) throw new Error('--run-approved-plan requires --sha256.')
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

/**
 * Filters manifest frameworks.
 *
 * @param {object[]} frameworks framework entries
 * @param {Set<string>} targets selected ids or kinds
 * @returns {object[]} selected entries
 */
function filterFrameworks (frameworks, targets) {
  if (targets.size === 0) return frameworks
  const selected = frameworks.filter(framework => targets.has(framework.id) || targets.has(framework.framework))
  if (selected.length === 0) throw new Error('No framework matched the requested selection.')
  return selected
}

/**
 * Returns a framework-scoped approval manifest.
 *
 * @param {object} manifest loaded manifest
 * @param {Set<string>} targets selected frameworks
 * @returns {object} approval manifest
 */
function getApprovalManifest (manifest, targets) {
  if (targets.size === 0) return manifest
  const approvalManifest = { ...manifest, frameworks: filterFrameworks(manifest.frameworks, targets) }
  Object.defineProperty(approvalManifest, '__sourceSha256', {
    enumerable: false,
    value: manifest.__sourceSha256,
  })
  return approvalManifest
}

/**
 * Adds explicit not-reached results for advanced scenarios.
 *
 * @param {object[]} results result list
 * @param {object} framework framework entry
 * @param {Set<string>} scenarios selected scenarios
 * @param {object} blocker blocking result
 * @returns {void}
 */
function addAdvancedNotReached (results, framework, scenarios, blocker) {
  for (const scenario of getAdvancedScenarios(scenarios)) {
    results.push({
      frameworkId: framework.id,
      scenario,
      status: 'skip',
      diagnosis: 'Not reached because Basic Reporting did not establish the direct reporting path.',
      evidence: {
        blockedBy: blocker?.scenario || 'basic-reporting',
        ...(blocker?.evidence?.blockerCategory
          ? { blockerCategory: blocker.evidence.blockerCategory }
          : {}),
        validationIncomplete: true,
      },
      artifacts: [],
    })
  }
}

/**
 * Adds local not-reached results for a non-runnable framework.
 *
 * @param {object[]} results result list
 * @param {object} framework framework entry
 * @param {Set<string>} scenarios selected scenarios
 * @param {string} reasonCode blocker id
 * @param {string} [blockerCategoryOverride] blocker category supplied by a runtime result
 * @returns {void}
 */
function addNotReachedLocalResults (results, framework, scenarios, reasonCode, blockerCategoryOverride) {
  const blockerCategory = blockerCategoryOverride || framework.blockerCategory || (
    framework.status === 'requires_manual_setup'
      ? BLOCKER_CATEGORIES.PROJECT_SETUP_REQUIRED
      : BLOCKER_CATEGORIES.VALIDATOR_LIMITATION
  )
  for (const scenario of scenarios) {
    if (scenario === CI_WIRING) continue
    results.push({
      frameworkId: framework.id,
      scenario,
      status: 'skip',
      diagnosis: 'Not reached because this framework has no available direct-runner validation target.',
      evidence: { blockerCategory, reasonCode, validationIncomplete: true },
      artifacts: [],
    })
  }
}

/**
 * Adds fail-closed results for missing orchestration output.
 *
 * @param {object[]} results result list
 * @param {object[]} frameworks selected frameworks
 * @param {Set<string>} scenarios selected scenarios
 * @returns {void}
 */
function addMissingResults (results, frameworks, scenarios) {
  for (const framework of frameworks) {
    for (const scenario of scenarios) {
      if (results.some(result => result.frameworkId === framework.id && result.scenario === scenario)) continue
      results.push({
        frameworkId: framework.id,
        scenario,
        status: 'error',
        diagnosis: 'The selected check produced no result. This is a validator orchestration error.',
        evidence: { validationIncomplete: true, validationOrchestrationFailed: true },
        artifacts: [],
      })
    }
  }
}

/**
 * Returns selected advanced scenario ids.
 *
 * @param {Set<string>} scenarios selected scenarios
 * @returns {string[]} advanced scenarios
 */
function getAdvancedScenarios (scenarios) {
  return Object.keys(SCENARIOS).filter(scenario => scenario !== BASIC_REPORTING && scenarios.has(scenario))
}

/**
 * Returns all selectable scenarios.
 *
 * @returns {string[]} scenario ids
 */
function getSelectableScenarios () {
  return [...Object.keys(SCENARIOS), CI_WIRING]
}

/**
 * Normalizes scenario selection.
 *
 * @param {string} scenario requested scenario
 * @returns {Set<string>} effective scenarios
 */
function normalizeScenarioSelection (scenario) {
  if (!getSelectableScenarios().includes(scenario)) throw new Error(`Unknown scenario: ${scenario}`)
  if (scenario === BASIC_REPORTING || scenario === CI_WIRING) return new Set([scenario])
  return new Set([BASIC_REPORTING, scenario])
}

/**
 * Normalizes a framework target.
 *
 * @param {string} target target value
 * @returns {string} normalized target
 */
function normalizeFrameworkTarget (target) {
  const normalized = String(target).trim().replace(/(?<!:):+$/, '')
  if (!normalized) throw new Error('Framework target cannot be empty.')
  return normalized
}

/**
 * Validates the output directory.
 *
 * @param {object} manifest loaded manifest
 * @param {string} outputPath output path
 * @returns {string} absolute output path
 */
function validateOutputPath (manifest, outputPath) {
  const root = path.resolve(manifest.repository.root)
  const out = path.resolve(outputPath)
  const relative = path.relative(root, out)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Validation output directory must be a dedicated child of repository.root.')
  }
  return out
}

/**
 * Prevents incompatible CLI modes.
 *
 * @param {object} options parsed options
 * @returns {void}
 */
function assertCompatibleModes (options) {
  if (!options.runApprovedPlan) return
  if (options.help || options.initManifest || options.printPlan || options.validateManifest) {
    throw new Error('--run-approved-plan cannot be combined with another mode.')
  }
}

/**
 * Reads a required flag value.
 *
 * @param {string[]} argv arguments
 * @param {number} index value index
 * @param {string} flag flag name
 * @returns {string} flag value
 */
function requireValue (argv, index, flag) {
  if (!argv[index]) throw new Error(`${flag} requires a value.`)
  return argv[index]
}

/**
 * Prints CLI help.
 *
 * @returns {void}
 */
function printHelp () {
  console.log(`Usage: node ci/validate-test-optimization.js [options]

  --init-manifest
  --validate-manifest
  --print-plan
  --run-approved-plan <approval.json> --sha256 <digest>
  --manifest <path>
  --out <path>
  --framework <id>
  --scenario <${getSelectableScenarios().join('|')}>
  --keep-temp-files
  --verbose`)
}

/**
 * Logs one phase transition.
 *
 * @param {object} framework framework entry
 * @param {string} phase phase name
 * @param {string} status status
 * @returns {void}
 */
function logPhase (framework, phase, status) {
  console.log(sanitizeConsoleText(`[test-optimization-validator] ${framework.id}: ${phase}: ${status}`))
}

/**
 * Builds a non-runnable framework result.
 *
 * @param {object} framework framework entry
 * @returns {object} result
 */
function getFrameworkStatusResult (framework) {
  const blockerCategory = framework.blockerCategory || (
    framework.status === 'requires_manual_setup'
      ? BLOCKER_CATEGORIES.PROJECT_SETUP_REQUIRED
      : BLOCKER_CATEGORIES.VALIDATOR_LIMITATION
  )
  const domain = getBlockerDomain(blockerCategory)
  return {
    frameworkId: framework.id,
    scenario: 'all',
    status: 'skip',
    diagnosis: framework.notes?.[0] || `Framework status is ${framework.status}.`,
    evidence: {
      blockerCategory,
      domain,
      frameworkStatus: framework.status,
      validationIncomplete: true,
      ...(blockerCategory === BLOCKER_CATEGORIES.PROJECT_SETUP_REQUIRED
        ? {
            blockedByProjectSetup: true,
            ...(framework.notes?.[0] ? { recommendation: framework.notes[0] } : {}),
          }
        : {
            validatorAdapterUnavailable: true,
            ...(framework.notes?.[0] ? { recommendation: framework.notes[0] } : {}),
          }),
    },
    artifacts: [],
  }
}

/**
 * Builds an unavailable runner result.
 *
 * @param {object} framework framework entry
 * @param {string} unavailable missing file
 * @returns {object} result
 */
function getUnavailableRunnerResult (framework, unavailable) {
  return {
    frameworkId: framework.id,
    scenario: 'all',
    status: 'skip',
    diagnosis: `The direct runner is unavailable: ${unavailable}. Complete normal project setup and retry.`,
    evidence: {
      blockerCategory: BLOCKER_CATEGORIES.PROJECT_SETUP_REQUIRED,
      blockedByProjectSetup: true,
      unavailableRunner: unavailable,
      validationIncomplete: true,
    },
    artifacts: [],
  }
}

/**
 * Builds a static project blocker result.
 *
 * @param {object} framework framework entry
 * @param {object} blocker static blocker
 * @param {string} reportPath static report path
 * @returns {object} result
 */
function getStaticFailure (framework, blocker, reportPath) {
  const blockerCategory = blocker.blockerCategory || BLOCKER_CATEGORIES.PROJECT_SETUP_REQUIRED
  return {
    frameworkId: framework.id,
    scenario: 'all',
    status: 'error',
    diagnosis: blocker.reason,
    evidence: {
      blockerCategory,
      domain: getBlockerDomain(blockerCategory),
      recommendation: blocker.recommendation,
      staticDiagnosis: reportPath,
      validationIncomplete: true,
      ...(blockerCategory === BLOCKER_CATEGORIES.PROJECT_SETUP_REQUIRED
        ? { blockedByProjectSetup: true }
        : {}),
    },
    artifacts: [reportPath],
  }
}

/**
 * Builds a Basic Reporting not-reached result.
 *
 * @param {object} framework framework entry
 * @param {string} diagnosis blocker diagnosis
 * @param {string} reasonCode blocker id
 * @param {string | undefined} blockerCategory blocker category
 * @returns {object} result
 */
function getBasicNotReached (framework, diagnosis, reasonCode, blockerCategory) {
  return {
    frameworkId: framework.id,
    scenario: BASIC_REPORTING,
    status: 'skip',
    diagnosis: `Basic Reporting was not reached: ${diagnosis}`,
    evidence: {
      ...(blockerCategory ? { blockerCategory } : {}),
      reasonCode,
      validationIncomplete: true,
    },
    artifacts: [],
  }
}

/**
 * Builds a cleanup failure.
 *
 * @param {Error|undefined} error cleanup error
 * @param {object} cleanup cleanup outcome
 * @returns {object} result
 */
function getCleanupFailure (error, cleanup) {
  const retained = (cleanup.filesRetained || 0) + (cleanup.directoriesRetained || 0)
  const reason = error?.message || error ||
    `${retained} temporary validation path${retained === 1 ? '' : 's'} remained after safe cleanup`
  return {
    frameworkId: 'validation-cleanup',
    scenario: 'all',
    status: 'error',
    diagnosis: `Temporary validation files could not be removed safely: ${reason}`,
    evidence: { cleanup, cleanupFailed: true, validationIncomplete: true },
    artifacts: [],
  }
}

/**
 * Builds a top-level orchestration failure.
 *
 * @param {Error} error failure
 * @returns {object} result
 */
function getOrchestrationFailure (error) {
  const blockerEvidence = getValidationBlockerEvidence(error)
  return {
    frameworkId: 'validator',
    scenario: 'all',
    status: blockerEvidence ? 'blocked' : 'error',
    diagnosis: error?.message || String(error),
    evidence: blockerEvidence || { validationIncomplete: true, validationOrchestrationFailed: true },
    artifacts: [],
  }
}

module.exports = { filterFrameworks, main, normalizeFrameworkTarget, parseArgs }
