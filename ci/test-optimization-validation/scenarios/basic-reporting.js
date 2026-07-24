'use strict'

const { getCommandBlocker } = require('../command-blocker')
const { runCommand } = require('../command-runner')
const { getBasicCommand } = require('../runner-command')

const {
  basicEventEvidence,
  failWithDebugRerun,
  frameworkOutDir,
  hasAllBasicEventTypes,
  inconclusive,
  pass,
  runInstrumentedCommand,
} = require('./helpers')

/**
 * Checks whether controlled initialization reports one real project test.
 *
 * @param {object} input scenario inputs
 * @param {object} input.framework framework manifest entry
 * @param {string} input.out validation output directory
 * @param {object} input.options validator options
 * @returns {Promise<object>} scenario result
 */
async function runBasicReporting ({ framework, out, options }) {
  const scenarioName = 'basic-reporting'
  const command = getBasicCommand(framework)
  let outDir

  try {
    const run = await runInstrumentedCommand({
      allowMissingInitialization: true,
      command,
      framework,
      options,
      out,
      scenarioName,
    })
    outDir = run.outDir
    const complete = hasAllBasicEventTypes(run.events)
    const evidence = {
      ...basicEventEvidence(run.events),
      commandExitCode: run.result.exitCode,
      commandOutputSummary: summarizeTestOutput(run.result.stdout, run.result.stderr),
      commandTimedOut: run.result.timedOut,
      foundationalReportingEstablished: complete &&
        run.offline.initialized &&
        run.offline.inputs.settings?.status === 'loaded' &&
        run.result.exitCode === 0 &&
        !run.result.timedOut,
      offlineExporterInitialized: run.offline.initialized,
      preflight: summarizePreflight(framework.preflight),
      reportingPath: complete ? 'validator-direct-runner' : 'none',
      settingsLoadedFromCache: run.offline.inputs.settings?.status === 'loaded',
    }

    if (run.result.timedOut) {
      return inconclusive(
        framework,
        scenarioName,
        'The initialized direct test exceeded its approved timeout. Basic Reporting remains incomplete.',
        { ...evidence, commandFailure: classifyFailure(framework, run.result) },
        outDir
      )
    }

    if (evidence.foundationalReportingEstablished) {
      return pass(
        framework,
        scenarioName,
        'The direct test emitted session, module, suite, and test events.',
        evidence,
        outDir
      )
    }

    if (!run.offline.initialized || !evidence.settingsLoadedFromCache) {
      return failWithDebugRerun({
        command,
        diagnosis: run.offline.initialized
          ? 'The clean test passed, but Test Optimization did not load the validator-owned offline settings.'
          : 'The clean test passed, but the offline Test Optimization exporter did not initialize.',
        evidence: {
          ...evidence,
          possibleLibraryBug: true,
          recommendation: 'Inspect the debug artifact for dd-trace initialization errors and report it with the ' +
            'framework and dd-trace versions.',
        },
        framework,
        options,
        out,
        outDir,
        scenarioName,
      })
    }

    if (run.result.exitCode !== 0) {
      evidence.commandFailure = classifyFailure(framework, run.result)
      const confirmation = await runCleanConfirmation({ command, framework, options, out })
      evidence.cleanConfirmation = confirmation.evidence
      if (!confirmation.evidence.matchesPreflight) {
        return inconclusive(
          framework,
          scenarioName,
          'The clean baseline changed between runs, so the initialized failure cannot be attributed to dd-trace.',
          evidence,
          outDir,
          confirmation.artifacts
        )
      }
      const result = await failWithDebugRerun({
        command,
        diagnosis: complete
          ? `The test passed twice without Datadog but exited ${run.result.exitCode} when initialized, after ` +
            'emitting ' +
            'the complete event hierarchy. This is a possible dd-trace compatibility bug.'
          : `The test passed twice without Datadog but exited ${run.result.exitCode} when initialized and did not ` +
            'emit the complete event hierarchy. This is a possible dd-trace adapter or compatibility bug.',
        evidence: {
          ...evidence,
          possibleLibraryBug: true,
          recommendation: 'Attach the debug run, clean confirmations, framework version, and dd-trace version to ' +
            'the engineering investigation.',
        },
        framework,
        options,
        out,
        outDir,
        scenarioName,
      })
      result.artifacts.push(...confirmation.artifacts)
      return result
    }

    const missing = getMissingLevels(evidence)
    return failWithDebugRerun({
      command,
      diagnosis: 'The direct test passed cleanly and while initialized, but no complete Test Optimization event ' +
        `hierarchy was captured. Missing levels: ${missing.join(', ')}. This is a possible dd-trace adapter bug.`,
      evidence: {
        ...evidence,
        missingEventLevels: missing,
        possibleLibraryBug: true,
        recommendation: 'Inspect the debug artifact for initialization and adapter errors. Include it with the ' +
          'framework and dd-trace versions in an engineering investigation.',
      },
      framework,
      options,
      out,
      outDir,
      scenarioName,
    })
  } catch (error) {
    return {
      frameworkId: framework.id,
      scenario: scenarioName,
      status: 'error',
      diagnosis: `Basic Reporting could not complete: ${error?.message || error}`,
      evidence: { validationIncomplete: true },
      artifacts: outDir ? [outDir] : [],
    }
  }
}

/**
 * Repeats the direct clean command after an initialized-only failure.
 *
 * @param {object} input confirmation inputs
 * @param {object} input.command direct command
 * @param {object} input.framework framework entry
 * @param {object} input.options validator options
 * @param {string} input.out output root
 * @returns {Promise<{artifacts: string[], evidence: object}>} confirmation evidence
 */
async function runCleanConfirmation ({ command, framework, options, out }) {
  const outDir = frameworkOutDir(out, framework, 'basic-reporting-clean-confirmation')
  const result = await runCommand(command, {
    artifactRoot: out,
    envMode: 'clean',
    label: `${framework.id}:basic-reporting:clean-confirmation`,
    outDir,
    repositoryRoot: options.repositoryRoot,
    requireExecutableApproval: options.requireExecutableApproval,
    verbose: options.verbose,
  })
  return {
    artifacts: Object.values(result.artifacts),
    evidence: {
      exitCode: result.exitCode,
      matchesPreflight: !result.timedOut &&
        framework.preflight?.exitCode === result.exitCode,
      timedOut: result.timedOut,
    },
  }
}

/**
 * Returns a compact preflight summary.
 *
 * @param {object} preflight preflight evidence
 * @returns {object} compact evidence
 */
function summarizePreflight (preflight = {}) {
  return {
    durationMs: preflight.durationMs,
    exitCode: preflight.exitCode,
    observedTestCount: preflight.observedTestCount,
    ran: preflight.ran === true,
    timedOut: preflight.timedOut === true,
  }
}

/**
 * Classifies a direct command failure.
 *
 * @param {object} framework framework entry
 * @param {object} result command result
 * @returns {object|undefined} blocker
 */
function classifyFailure (framework, result) {
  return getCommandBlocker(result, {
    browserRequired: framework.browserRequired,
    framework: framework.framework,
  })
}

/**
 * Returns missing Test Optimization hierarchy levels.
 *
 * @param {object} evidence event evidence
 * @returns {string[]} missing levels
 */
function getMissingLevels (evidence) {
  return [
    ['session', evidence.testSessionEvents],
    ['module', evidence.testModuleEvents],
    ['suite', evidence.testSuiteEvents],
    ['test', evidence.testEvents],
  ].filter(([, count]) => count < 1).map(([level]) => level)
}

/**
 * Extracts bounded useful test output lines.
 *
 * @param {string} [stdout] command stdout
 * @param {string} [stderr] command stderr
 * @returns {string[]} output summary
 */
function summarizeTestOutput (stdout = '', stderr = '') {
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/)
  const interesting = lines.filter(line => {
    return /\b(?:error|fail|pass|scenario|suite|test|timed out|warning)\b/i.test(line)
  })
  return [...new Set(interesting.map(line => line.trim()).filter(Boolean))].slice(-12)
}

module.exports = { runBasicReporting, summarizeTestOutput }
