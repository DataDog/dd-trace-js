'use strict'

const path = require('node:path')

const CONFIG_PATTERN = /^cypress(?:\.config)?\.(?:[cm]?[jt]s|json)$/
const TEST_FILE_PATTERN = /(?:\.cy\.[cm]?[jt]sx?|\.(?:spec|test)\.[cm]?[jt]sx?)$/

/**
 * Reports whether a file follows a Cypress spec convention.
 *
 * @param {string} filename candidate filename
 * @param {string} directory candidate parent directory
 * @param {string} projectRoot detected project root
 * @returns {boolean} whether the candidate can be selected by Cypress
 */
function isTestFile (filename, directory, projectRoot) {
  if (/\.cy\.[cm]?[jt]sx?$/.test(filename)) return true
  const relativeDirectory = new Set(path.relative(projectRoot, directory).split(path.sep))
  return relativeDirectory.has('cypress') &&
    (relativeDirectory.has('e2e') || relativeDirectory.has('integration')) &&
    TEST_FILE_PATTERN.test(filename)
}

/**
 * Returns the complete suffix that a generated Cypress spec must preserve.
 *
 * @param {string} filename representative Cypress spec
 * @returns {string} generated spec suffix
 */
function getTestExtension (filename) {
  return TEST_FILE_PATTERN.exec(path.basename(filename))?.[0] || '.cy.js'
}

/**
 * Returns validator-owned Cypress source for one generated scenario.
 *
 * @param {object} input generated source input
 * @param {string} input.scenarioId generated scenario id
 * @param {string} input.testName generated test name
 * @returns {string} canonical generated Cypress source
 */
function getGeneratedTestContent ({ scenarioId, testName }) {
  const lines = []
  if (scenarioId === 'atr-fail-once') {
    lines.push('let attempt = 0', '')
  }
  lines.push(
    "describe('dd-test-optimization-validation', () => {",
    `  it(${JSON.stringify(testName)}, () => {`,
    scenarioId === 'atr-fail-once'
      ? '    expect(attempt++).to.equal(1)'
      : '    expect(true).to.equal(true)',
    '  })',
    '})'
  )
  return lines.join('\n')
}

/**
 * Returns Cypress arguments that select one existing project spec.
 *
 * @param {string} filename selected Cypress spec
 * @returns {string[]} focused Cypress arguments
 */
function getFocusedTestArgs (filename) {
  return ['--spec', filename]
}

/**
 * Returns Cypress arguments for one isolated generated scenario.
 *
 * @param {string} filename generated Cypress spec
 * @param {string[]} configurationArgs approved Cypress configuration arguments
 * @returns {string[]} generated scenario arguments
 */
function getGeneratedTestArgs (filename, configurationArgs) {
  return [
    'run',
    ...configurationArgs,
    '--spec',
    filename,
    '--config',
    'video=false,screenshotOnRunFailure=false,retries=0',
  ]
}

/**
 * Extracts the executed-test count from the final Cypress run summary.
 *
 * @param {string} output Cypress output without ANSI escapes
 * @returns {number|null} final test count when present
 */
function getObservedTestCount (output) {
  let count = null
  for (const match of output.matchAll(/\bTests\s*:\s*(\d+)\b/gi)) count = Number(match[1])
  return count
}

module.exports = {
  CONFIG_PATTERN,
  getFocusedTestArgs,
  getGeneratedTestArgs,
  getGeneratedTestContent,
  getObservedTestCount,
  getTestExtension,
  isTestFile,
}
