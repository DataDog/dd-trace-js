'use strict'

/* eslint-disable no-console */

const fs = require('fs')
const path = require('path')

const { runBasicReporting } = require('./scenarios/basic-reporting')
const { runEarlyFlakeDetection } = require('./scenarios/early-flake-detection')
const { runAutoTestRetries } = require('./scenarios/auto-test-retries')
const { runTestManagement } = require('./scenarios/test-management')
const { cleanupGeneratedFiles } = require('./generated-files')
const { loadManifest } = require('./manifest-loader')
const { MockIntake } = require('./mock-intake')
const { writeReport } = require('./report-writer')
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

function parseArgs (argv) {
  const options = {
    manifest: DEFAULT_MANIFEST,
    out: DEFAULT_OUT,
    frameworks: new Set(),
    scenarios: new Set(Object.keys(SCENARIOS)),
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
        options.frameworks.add(requireValue(argv, ++i, arg))
        break
      case '--scenario':
        options.scenarios = new Set([requireValue(argv, ++i, arg)])
        break
      case '--keep-temp-files':
        options.keepTempFiles = true
        break
      case '--verbose':
        options.verbose = true
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
    if (!SCENARIOS[scenario]) {
      throw new Error(`Unknown scenario "${scenario}". Expected one of: ${Object.keys(SCENARIOS).join(', ')}`)
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
  --framework <id>        Run one framework entry. Can be repeated.
  --scenario <name>       Run one scenario: ${Object.keys(SCENARIOS).join(', ')}
  --keep-temp-files       Leave generated validation files in place.
  --verbose               Print command progress.
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
    const out = path.resolve(options.out)
    fs.mkdirSync(out, { recursive: true })
    const staticDiagnosis = runStaticDiagnosis({ manifest, out })

    const intake = new MockIntake({ out, verbose: options.verbose })
    const results = []
    let intakeStarted = false

    try {
      const frameworks = manifest.frameworks.filter(framework => {
        return options.frameworks.size === 0 || options.frameworks.has(framework.id)
      })
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

        runnableFrameworks.push(framework)
      }

      if (runnableFrameworks.length > 0) {
        await intake.start()
        intakeStarted = true
      }

      for (const framework of runnableFrameworks) {
        for (const scenario of options.scenarios) {
          const runScenario = SCENARIOS[scenario]
          // Scenarios intentionally run in order so each one can reset and configure the shared intake.
          // eslint-disable-next-line no-await-in-loop
          results.push(await runScenario({ manifest, framework, intake, out, options }))
        }
      }
    } finally {
      if (intakeStarted) await intake.close()
      await cleanupGeneratedFiles(manifest, { keep: options.keepTempFiles })
    }

    await writeReport({ manifest, results, out, intake, staticDiagnosis })
    process.exitCode = results.some(result => result.status === 'fail' || result.status === 'error') ? 1 : 0
  } catch (err) {
    process.exitCode = 1
    console.error(err && err.stack ? err.stack : err)
  }
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
  if (framework.status === 'unsupported_by_validator') {
    return {
      frameworkId: framework.id,
      scenario: 'all',
      status: 'fail',
      diagnosis: `${framework.framework} is not supported by the deterministic validator.`,
      evidence: {
        recommendation: 'Choose a supported framework before running live validation.',
      },
      artifacts: [],
    }
  }

  return {
    frameworkId: framework.id,
    scenario: 'all',
    status: 'skip',
    diagnosis: `Framework status is ${framework.status}.`,
    evidence: {},
    artifacts: [],
  }
}

module.exports = { main, parseArgs }
