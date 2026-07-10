'use strict'

const { runCommand, serializeDisplayCommand } = require('./command-runner')
const {
  cleanupGeneratedRuntimeFiles,
  writeGeneratedFiles,
} = require('./generated-files')
const {
  getDatadogCleanCommand,
  getLocalValidationCommand,
} = require('./local-command')
const { frameworkOutDir } = require('./scenarios/helpers')
const { getObservedTestCount } = require('./test-output')

/**
 * Verifies generated scenario commands without Datadog initialization.
 *
 * @param {object} input verification inputs
 * @param {object} input.framework manifest framework entry
 * @param {string} input.out validation output directory
 * @param {object} input.options validator options
 * @returns {Promise<{ok: boolean, failure?: object}>} verification outcome
 */
async function verifyGeneratedTestStrategy ({ framework, out, options }) {
  const strategy = framework.generatedTestStrategy
  if (!strategy || !['planned', 'verified'].includes(strategy.status)) return { ok: true }

  const evidence = {
    scenarios: [],
  }
  const artifacts = []
  const startedAt = Date.now()

  try {
    cleanupGeneratedRuntimeFiles(framework)
    writeGeneratedFiles(framework)

    for (const scenario of strategy.scenarios) {
      cleanupGeneratedRuntimeFiles(framework)
      const command = getDatadogCleanCommand(getLocalValidationCommand(framework, scenario.runCommand))
      const outDir = frameworkOutDir(out, framework, `generated-verification-${scenario.id}`)
      // Generated commands run serially because fail-once state and cleanup are scenario-local.
      // eslint-disable-next-line no-await-in-loop
      const result = await runCommand(command, {
        artifactRoot: out,
        envMode: 'clean',
        label: `${framework.id}:generated-verification:${scenario.id}`,
        outDir,
        verbose: options.verbose,
      })
      const observedTestCount = getObservedTestCount(framework.framework, result.stdout, result.stderr)
      const expected = scenario.expectedWithoutDatadog
      const scenarioEvidence = {
        id: scenario.id,
        command: serializeDisplayCommand(command),
        exitCode: result.exitCode,
        expectedExitCode: expected.exitCode,
        observedTestCount,
        expectedTestCount: expected.observedTestCount,
        localAdjustments: command.localAdjustments || [],
      }
      evidence.scenarios.push(scenarioEvidence)
      artifacts.push(...Object.values(result.artifacts))

      if (result.timedOut || result.exitCode !== expected.exitCode ||
        observedTestCount !== expected.observedTestCount) {
        cleanupGeneratedRuntimeFiles(framework)
        return getVerificationFailure(framework, evidence, artifacts, scenarioEvidence, result.timedOut)
      }
    }

    cleanupGeneratedRuntimeFiles(framework)
    strategy.status = 'verified'
    strategy.verification = {
      source: 'validator',
      ran: true,
      durationMs: Date.now() - startedAt,
      observedScenarios: evidence.scenarios,
      cleanupCompleted: true,
    }
    return { ok: true }
  } catch (error) {
    cleanupGeneratedRuntimeFiles(framework)
    return {
      ok: false,
      failure: {
        frameworkId: framework.id,
        scenario: 'generated-test-verification',
        status: 'error',
        diagnosis: 'The validator could not verify the generated test strategy. No advanced-feature conclusion ' +
          `was reached: ${error.message || error}`,
        evidence,
        artifacts,
      },
    }
  }
}

/**
 * Builds a failure when a generated scenario does not behave as declared.
 *
 * @param {object} framework manifest framework entry
 * @param {object} evidence collected verification evidence
 * @param {string[]} artifacts command artifacts
 * @param {object} scenario failed scenario evidence
 * @param {boolean} timedOut whether the scenario timed out
 * @returns {{ok: false, failure: object}} generated verification failure
 */
function getVerificationFailure (framework, evidence, artifacts, scenario, timedOut) {
  const reason = timedOut
    ? 'timed out'
    : `exited ${scenario.exitCode} with ${formatObservedCount(scenario.observedTestCount)}; expected exit ` +
      `${scenario.expectedExitCode} and ${scenario.expectedTestCount} test`
  return {
    ok: false,
    failure: {
      frameworkId: framework.id,
      scenario: 'generated-test-verification',
      status: 'error',
      diagnosis: `Generated scenario "${scenario.id}" ${reason}. No advanced-feature conclusion was reached.`,
      evidence,
      artifacts,
    },
  }
}

/**
 * Formats a parsed test count for a customer-facing diagnosis.
 *
 * @param {number|null} count observed test count
 * @returns {string} formatted count
 */
function formatObservedCount (count) {
  return count === null ? 'an unknown test count' : `${count} observed tests`
}

module.exports = { verifyGeneratedTestStrategy }
