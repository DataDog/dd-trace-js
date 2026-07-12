'use strict'

/* eslint-disable no-console */

const fs = require('fs')
const path = require('path')

const { getFrameworkDefinitions } = require('../diagnose')
const { DD_MAJOR } = require('../../version')

const { assertApprovalDigest } = require('./approval')

const { runBasicReporting } = require('./scenarios/basic-reporting')
const { runEarlyFlakeDetection } = require('./scenarios/early-flake-detection')
const { runAutoTestRetries } = require('./scenarios/auto-test-retries')
const { runTestManagement } = require('./scenarios/test-management')
const { runCiWiring } = require('./scenarios/ci-wiring')
const { cleanupGeneratedFiles } = require('./generated-files')
const { verifyGeneratedTestStrategy } = require('./generated-verifier')
const { serializeDisplayCommand } = require('./command-runner')
const {
  annotateCiDiscovery,
  getFrameworkCiDiscoveryContradiction,
} = require('./ci-discovery')
const {
  buildExecutionEnvironmentBlockerResult,
  isLocalSocketPermissionError,
} = require('./execution-environment')
const { loadManifest } = require('./manifest-loader')
const { MockIntake } = require('./mock-intake')
const { formatExecutionPlan } = require('./plan-writer')
const { runFrameworkPreflight } = require('./preflight-runner')
const { sanitizeConsoleText } = require('./redaction')
const { writeReport } = require('./report-writer')
const { ensureSafeDirectory } = require('./safe-files')
const { runSetupCommands } = require('./setup-runner')
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
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--manifest':
        options.manifest = requireValue(argv, ++i, arg)
        break
      case '--out':
        options.out = requireValue(argv, ++i, arg)
        break
      case '--framework':
        options.frameworks.add(normalizeFrameworkTarget(requireValue(argv, ++i, arg)))
        break
      case '--scenario':
        options.requestedScenario = requireValue(argv, ++i, arg)
        options.scenarios = normalizeScenarioSelection(options.requestedScenario)
        break
      case '--keep-temp-files':
        options.keepTempFiles = true
        break
      case '--verbose':
        options.verbose = true
        break
      case '--validate-manifest':
        options.validateManifest = true
        break
      case '--print-plan':
        options.printPlan = true
        break
      case '--approved-plan-sha256':
        options.approvedPlanSha256 = requireValue(argv, ++i, arg)
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
  --print-plan            Print the normalized execution plan without running project code.
  --approved-plan-sha256  Bind live execution to the exact manifest and options shown by --print-plan.
  --help                  Show this help.
`)
}

async function main (argv) {
  try {
    const options = parseArgs(argv)
    if (options.help) {
      printHelp()
      return
    }

    const manifest = loadManifest(options.manifest)
    if (options.printPlan) {
      const out = validateOutputPath(manifest, options.out)
      manifest.frameworks = filterFrameworks(manifest.frameworks, options.frameworks)
      console.log(formatExecutionPlan({
        manifest,
        out,
        selectedFrameworkIds: options.frameworks.size > 0
          ? manifest.frameworks.map(framework => framework.id)
          : [],
        requestedScenario: options.requestedScenario,
        keepTempFiles: options.keepTempFiles,
        verbose: options.verbose,
      }))
      return
    }
    if (options.validateManifest) {
      console.log(sanitizeConsoleText(`Validation manifest is valid: ${manifest.__path}`))
      return
    }
    if (!options.approvedPlanSha256) {
      throw new Error(
        'Live validation requires the --approved-plan-sha256 value emitted by --print-plan. ' +
        'Render and approve a fresh execution plan first.'
      )
    }
    const out = validateOutputPath(manifest, options.out)
    const selectedFrameworks = filterFrameworks(manifest.frameworks, options.frameworks)
    assertApprovalDigest(options.approvedPlanSha256, {
      manifest,
      out,
      selectedFrameworkIds: options.frameworks.size > 0
        ? selectedFrameworks.map(framework => framework.id)
        : [],
      requestedScenario: options.requestedScenario,
      keepTempFiles: options.keepTempFiles,
      verbose: options.verbose,
    })
    ensureSafeDirectory(manifest.repository.root, out, 'validation output directory', { allowRootSymlink: true })
    const staticDiagnosis = runStaticDiagnosis({ manifest, out })
    annotateCiDiscovery({ manifest, diagnosis: staticDiagnosis.report })

    const intake = new MockIntake({ out, verbose: options.verbose })
    const results = []
    let intakeStarted = false

    try {
      const frameworks = filterFrameworks(manifest.frameworks, options.frameworks)
      const liveReadyFrameworks = []
      const runnableFrameworks = []

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

      if (liveReadyFrameworks.length > 0) {
        try {
          logValidationProgress('Starting the local mock intake.')
          await intake.start()
          intakeStarted = true
          logValidationProgress('Local mock intake ready.')
        } catch (err) {
          for (const framework of liveReadyFrameworks) {
            results.push(getIntakeStartupFailure(framework, err))
          }
          liveReadyFrameworks.length = 0
        }
      }

      for (const framework of liveReadyFrameworks) {
        // Setup commands are project preparation, not Test Optimization signal collection.
        if (framework.setup?.commands?.length > 0) logPhaseStart(framework, 'Project setup')
        // eslint-disable-next-line no-await-in-loop
        const setup = await runSetupCommands({ framework, out, options })
        if (framework.setup?.commands?.length > 0) {
          logPhaseComplete(framework, 'Project setup', setup.ok ? 'pass' : setup.failure?.status)
        }
        if (!setup.ok) {
          results.push(setup.failure)
          continue
        }

        runnableFrameworks.push(framework)
      }
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
          // Scenarios intentionally run in order so each one can reset and configure the shared intake.
          if (preflight.ok) {
            logPhaseStart(framework, 'Basic Reporting')
            // eslint-disable-next-line no-await-in-loop
            basicResult = await SCENARIOS[BASIC_REPORTING_SCENARIO]({ manifest, framework, intake, out, options })
            logPhaseComplete(framework, 'Basic Reporting', basicResult.status)
          } else {
            basicResult = preflight.failure
          }
          results.push(basicResult)
        }

        if (options.scenarios.has(CI_WIRING_SCENARIO) &&
          shouldRunCiWiringValidation(framework, manifest, options)) {
          if (basicResult && basicResult.status !== 'pass') {
            results.push(getSkippedCiWiringAfterBasicFailure(framework, basicResult))
          } else {
            // CI wiring runs after Basic Reporting proves this framework can report when initialized directly.
            logPhaseStart(framework, 'CI wiring')
            // eslint-disable-next-line no-await-in-loop
            const ciWiringResult = await runCiWiring({ manifest, framework, intake, out, options, basicResult })
            results.push(ciWiringResult)
            logPhaseComplete(framework, 'CI wiring', ciWiringResult.status)
          }
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
          // Scenarios intentionally run in order so each one can reset and configure the shared intake.
          logPhaseStart(framework, getScenarioDisplayName(scenario))
          // eslint-disable-next-line no-await-in-loop
          const result = await runScenario({ manifest, framework, intake, out, options })
          results.push(result)
          logPhaseComplete(framework, getScenarioDisplayName(scenario), result.status)
        }
      }
    } finally {
      if (intakeStarted) await intake.close()
      await cleanupGeneratedFiles(manifest, { keep: options.keepTempFiles })
    }

    await writeReport({ manifest, results, out, intake, staticDiagnosis })
    process.exitCode = results.some(isUnsuccessfulResult) ? 1 : 0
  } catch (err) {
    process.exitCode = 1
    console.error(sanitizeConsoleText(err && err.stack ? err.stack : err))
  }
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

function shouldRunCiWiringValidation (framework, manifest, options) {
  return hasCiWiringValidation(framework, manifest) || options.requestedScenario === CI_WIRING_SCENARIO
}

function hasCiWiringValidation (framework, manifest) {
  return framework.ciWiringCommand || framework.ciWiring ||
    Boolean(getFrameworkCiDiscoveryContradiction(framework, manifest))
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

function getSelectableScenarios () {
  return [...Object.keys(SCENARIOS), CI_WIRING_SCENARIO]
}

function getSkippedCiWiringAfterBasicFailure (framework, basicResult) {
  return {
    frameworkId: framework.id,
    scenario: 'ci-wiring',
    status: 'skip',
    diagnosis: 'Skipped CI wiring validation because Basic Reporting did not pass with direct Datadog ' +
      'initialization. Fix the selected test command or local Test Optimization capability before diagnosing CI ' +
      'wiring.',
    evidence: {
      blockedBy: BASIC_REPORTING_SCENARIO,
      basicReportingStatus: basicResult.status,
      basicReportingDiagnosis: basicResult.diagnosis,
      featureEligibility: {
        eligible: false,
        blockedBy: BASIC_REPORTING_SCENARIO,
        reasonCode: 'basic-reporting-failed',
        scenario: 'ci-wiring',
      },
      ciWiring: framework.ciWiring,
    },
    artifacts: [],
  }
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
    diagnosis: `Skipped because generated test verification did not pass: ${failure.diagnosis}`,
    evidence: {
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

function getIntakeStartupFailure (framework, err) {
  const message = err && err.message ? err.message : String(err)
  const permissionError = isLocalSocketPermissionError(err)
  if (permissionError) {
    return buildExecutionEnvironmentBlockerResult({
      framework,
      error: err,
      rerunCommand: getCurrentRerunCommand(),
    })
  }

  const diagnosis = `The local fake intake could not start, so live validation was not run: ${message}`
  const recommendation = 'Allow the validator to bind to 127.0.0.1, then rerun validation.'

  return {
    frameworkId: framework.id,
    scenario: 'all',
    status: 'error',
    diagnosis,
    evidence: {
      intakeStarted: false,
      error: message,
      errorCode: err?.code,
      errorSyscall: err?.syscall,
      recommendation,
    },
    artifacts: [],
  }
}

function getCurrentRerunCommand () {
  return serializeDisplayCommand({
    argv: [process.execPath, ...process.argv.slice(1)],
    usesShell: false,
  })
}

function isUnsuccessfulResult (result) {
  return result.status === 'fail' || result.status === 'error' || result.status === 'blocked'
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
