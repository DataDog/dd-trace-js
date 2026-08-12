'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { BLOCKER_CATEGORIES, getBlockerDomain } = require('./blocker-category')
const { getCommandBlocker } = require('./command-blocker')
const { runCommand, serializeDisplayCommand } = require('./command-runner')
const {
  cleanupGeneratedRuntimeFiles,
  writeGeneratedFiles,
} = require('./generated-files')
const { getGeneratedCommand } = require('./runner-command')
const { frameworkOutDir } = require('./scenarios/helpers')
const { getObservedTestCount } = require('./test-output')
const { getValidationBlockerEvidence } = require('./validation-blocker')

const GENERATED_SCENARIO_BY_FEATURE = {
  efd: 'basic-pass',
  atr: 'atr-fail-once',
  'test-management': 'test-management-target',
}

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

    for (const scenario of getScenariosToVerify(strategy.scenarios, options.scenarios)) {
      cleanupGeneratedRuntimeFiles(framework)
      writeGeneratedFiles(framework, scenario)
      const command = getGeneratedCommand(framework, scenario)
      const outDir = frameworkOutDir(out, framework, `generated-verification-${scenario.id}`)
      // Generated commands run serially because fail-once state and cleanup are scenario-local.
      // eslint-disable-next-line no-await-in-loop
      const result = await runCommand(command, {
        artifactRoot: out,
        envMode: 'clean',
        label: `${framework.id}:generated-verification:${scenario.id}`,
        outDir,
        repositoryRoot: options.repositoryRoot,
        requireExecutableApproval: options.requireExecutableApproval,
        verbose: options.verbose,
      })
      const observedTestCount = getObservedTestCount(framework.framework, result.stdout, result.stderr)
      const expected = scenario.expectedWithoutDatadog
      const failOnceStateCreated = scenario.id === 'atr-fail-once'
        ? getGeneratedRuntimeFileStatus(strategy)
        : undefined
      const scenarioEvidence = {
        id: scenario.id,
        command: serializeDisplayCommand(command),
        exitCode: result.exitCode,
        expectedExitCode: expected.exitCode,
        observedTestCount,
        expectedTestCount: expected.observedTestCount,
        localAdjustments: command.localAdjustments || [],
      }
      if (failOnceStateCreated !== undefined) scenarioEvidence.failOnceStateCreated = failOnceStateCreated
      evidence.scenarios.push(scenarioEvidence)
      artifacts.push(...Object.values(result.artifacts))

      const observedWrongTestCount = observedTestCount !== null &&
        observedTestCount !== expected.observedTestCount
      if (result.timedOut || result.exitCode !== expected.exitCode ||
        observedWrongTestCount || failOnceStateCreated === false) {
        cleanupGeneratedRuntimeFiles(framework)
        return getVerificationFailure(
          framework,
          evidence,
          artifacts,
          scenarioEvidence,
          result,
          observedTestCount
        )
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
    const blockerEvidence = getValidationBlockerEvidence(error)
    return {
      ok: false,
      failure: {
        frameworkId: framework.id,
        scenario: 'generated-test-verification',
        status: blockerEvidence ? 'blocked' : 'error',
        diagnosis: 'The validator could not run the temporary validation test as expected. No advanced-feature ' +
          `conclusion was reached: ${error.message || error}`,
        evidence: { ...evidence, ...blockerEvidence },
        artifacts,
      },
    }
  }
}

/**
 * Selects only generated tests required by the requested advanced checks.
 *
 * @param {object[]} scenarios generated test scenarios
 * @param {Set<string>} [selectedFeatures] validator scenario selection
 * @returns {object[]} generated scenarios to verify
 */
function getScenariosToVerify (scenarios, selectedFeatures) {
  if (!(selectedFeatures instanceof Set)) return scenarios

  const selectedScenarioIds = new Set()
  for (const feature of selectedFeatures) {
    const scenarioId = GENERATED_SCENARIO_BY_FEATURE[feature]
    if (scenarioId) selectedScenarioIds.add(scenarioId)
  }

  if (selectedScenarioIds.size === 0) return scenarios
  return scenarios.filter(scenario => selectedScenarioIds.has(scenario.id))
}

/**
 * Builds a failure when a generated scenario does not behave as declared.
 *
 * @param {object} framework manifest framework entry
 * @param {object} evidence collected verification evidence
 * @param {string[]} artifacts command artifacts
 * @param {object} scenario failed scenario evidence
 * @param {object} result command result
 * @param {number|null} observedTestCount observed generated test count
 * @returns {{ok: false, failure: object}} generated verification failure
 */
function getVerificationFailure (framework, evidence, artifacts, scenario, result, observedTestCount) {
  const commandFailure = getCommandBlocker(result, {
    browserRequired: framework.browserRequired,
    framework: framework.framework,
    packageJson: framework.project.packageJson,
    testsRan: Number.isInteger(observedTestCount) && observedTestCount > 0,
  })
  if (commandFailure) {
    const blockerCategory = commandFailure.blockerCategory
    const domain = getBlockerDomain(blockerCategory)
    return {
      ok: false,
      failure: {
        frameworkId: framework.id,
        scenario: 'generated-test-verification',
        status: 'blocked',
        diagnosis: `${commandFailure.summary} Advanced-feature validation could not start reliably.`,
        evidence: { ...evidence, blockerCategory, commandFailure, domain, validationIncomplete: true },
        artifacts,
      },
    }
  }
  let reason
  if (result.timedOut) {
    reason = 'timed out'
  } else if (scenario.id === 'atr-fail-once' && scenario.failOnceStateCreated === false) {
    reason = 'failed without creating its declared fail-once state file, so it failed for an unrelated reason'
  } else {
    reason = `exited ${scenario.exitCode} with ${formatObservedCount(scenario.observedTestCount)}; expected exit ` +
      `${scenario.expectedExitCode} and ${scenario.expectedTestCount} test`
  }
  return {
    ok: false,
    failure: {
      frameworkId: framework.id,
      scenario: 'generated-test-verification',
      status: 'error',
      diagnosis: `Temporary validation test "${scenario.id}" ${reason}. No advanced-feature conclusion was reached.`,
      evidence: {
        ...evidence,
        blockerCategory: BLOCKER_CATEGORIES.VALIDATOR_LIMITATION,
        validationIncomplete: true,
      },
      artifacts,
    },
  }
}

/**
 * Checks a declared generated runtime state file when the adapter uses one.
 *
 * @param {object} strategy generated test strategy
 * @returns {boolean|undefined} whether a declared runtime file exists, or undefined when none is required
 */
function getGeneratedRuntimeFileStatus (strategy) {
  const generatedFiles = new Set((strategy.files || []).map(file => path.resolve(file.path)))
  let expectsRuntimeFile = false
  if (strategy.cleanupPaths) {
    for (const cleanupPath of strategy.cleanupPaths) {
      const filename = path.resolve(cleanupPath)
      if (generatedFiles.has(filename)) continue
      expectsRuntimeFile = true
      try {
        const stat = fs.lstatSync(filename)
        if (!stat.isSymbolicLink() && stat.isFile()) return true
      } catch {}
    }
  }
  return expectsRuntimeFile ? false : undefined
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
