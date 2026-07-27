'use strict'

const path = require('node:path')

const CUCUMBER_PACKAGE = '@cucumber/cucumber'
const CONFIG_PATTERN = /^cucumber\.(?:[cm]?js|json|ya?ml)$/
const GENERATED_STEPS_FILENAME = 'dd-test-optimization-validation.steps.cjs'

/**
 * Reports whether a file follows the Cucumber feature convention.
 *
 * @param {string} filename candidate filename
 * @returns {boolean} whether the candidate can be selected by Cucumber
 */
function isTestFile (filename) {
  return filename.endsWith('.feature')
}

/**
 * Counts statically declared Cucumber scenarios in a feature.
 *
 * @param {string} source feature source
 * @returns {number} declared scenario count
 */
function getScenarioCount (source) {
  return [...source.matchAll(/^\s*Scenario(?: Outline)?:\s*\S/gm)].length
}

/**
 * Returns validator-owned Cucumber feature source for one generated scenario.
 *
 * @param {object} input generated source input
 * @param {string} input.testName generated scenario name
 * @returns {string} canonical generated feature source
 */
function getGeneratedTestContent ({ testName }) {
  return [
    'Feature: Datadog Test Optimization validation',
    '',
    `  Scenario: ${testName}`,
    `    Given the Datadog validation scenario ${JSON.stringify(testName)}`,
  ].join('\n')
}

/**
 * Returns the validator-owned Cucumber step definitions shared by generated scenarios.
 *
 * @returns {string} canonical generated step-definition source
 */
function getGeneratedStepsContent () {
  return [
    "'use strict'",
    '',
    `const { Given } = require(${JSON.stringify(CUCUMBER_PACKAGE)})`,
    '',
    'let atrAttempt = 0',
    '',
    "Given('the Datadog validation scenario {string}', function (scenario) {",
    "  if (scenario === 'atr-fail-once' && atrAttempt++ === 0) {",
    "    throw new Error('dd-test-optimization-validation atr first failure')",
    '  }',
    '})',
  ].join('\n')
}

/**
 * Returns the generated Cucumber step-definition path for a feature directory.
 *
 * @param {string} testDirectory generated feature directory
 * @returns {string} generated step-definition path
 */
function getGeneratedStepsPath (testDirectory) {
  return path.join(testDirectory, GENERATED_STEPS_FILENAME)
}

/**
 * Returns Cucumber arguments that select one existing feature.
 *
 * @param {string} filename selected Cucumber feature
 * @returns {string[]} focused Cucumber arguments
 */
function getFocusedTestArgs (filename) {
  return [filename, '--format', 'progress']
}

/**
 * Returns Cucumber arguments for one isolated generated scenario.
 *
 * @param {string} filename generated Cucumber feature
 * @param {string} stepsFile generated Cucumber step definitions
 * @returns {string[]} generated scenario arguments
 */
function getGeneratedTestArgs (filename, stepsFile) {
  return ['--require', stepsFile, '--format', 'progress', filename]
}

/**
 * Extracts the executed-scenario count from the final Cucumber summary.
 *
 * @param {string} output Cucumber output without ANSI escapes
 * @returns {number|null} final scenario count when present
 */
function getObservedTestCount (output) {
  let count = null
  for (const match of output.matchAll(/\b(\d+)\s+scenarios?\b/gi)) count = Number(match[1])
  return count
}

module.exports = {
  CONFIG_PATTERN,
  getFocusedTestArgs,
  getGeneratedStepsContent,
  getGeneratedStepsPath,
  getGeneratedTestArgs,
  getGeneratedTestContent,
  getObservedTestCount,
  getScenarioCount,
  isTestFile,
}
