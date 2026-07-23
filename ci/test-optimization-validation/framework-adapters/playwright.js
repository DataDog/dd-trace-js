'use strict'

const path = require('node:path')

const CONFIG_PATTERN = /^playwright\.config\.[cm]?[jt]s$/
const TEST_FILE_PATTERN = /(?:\.(?:spec|test)\.[cm]?[jt]sx?)$/
const GENERATED_CONFIG_FILENAME = 'dd-test-optimization-validation.playwright.config.cjs'
const PLAYWRIGHT_PACKAGE = '@playwright/test'

/**
 * Reports whether a file follows a Playwright Test convention.
 *
 * @param {string} filename candidate filename
 * @param {string} directory candidate parent directory
 * @param {string} projectRoot detected project root
 * @returns {boolean} whether the candidate can be selected by Playwright Test
 */
function isTestFile (filename, directory, projectRoot) {
  if (!TEST_FILE_PATTERN.test(filename)) return false
  const relative = path.relative(projectRoot, path.join(directory, filename))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * Returns the complete suffix that a generated Playwright spec must preserve.
 *
 * @param {string} filename representative Playwright spec
 * @returns {string} generated spec suffix
 */
function getTestExtension (filename) {
  return TEST_FILE_PATTERN.exec(path.basename(filename))?.[0] || '.spec.js'
}

/**
 * Returns validator-owned Playwright source for one generated scenario.
 *
 * @param {object} input generated source input
 * @param {string} input.moduleSystem generated module system
 * @param {string} input.scenarioId generated scenario id
 * @param {string} input.testName generated test name
 * @returns {string} canonical generated Playwright source
 */
function getGeneratedTestContent ({ moduleSystem, scenarioId, testName }) {
  const assertion = scenarioId === 'atr-fail-once'
    ? '  expect(test.info().retry).toBe(1)'
    : '  expect(true).toBe(true)'
  const imports = moduleSystem === 'commonjs'
    ? `const { expect, test } = require(${JSON.stringify(PLAYWRIGHT_PACKAGE)})`
    : `import { expect, test } from ${JSON.stringify(PLAYWRIGHT_PACKAGE)}`
  return [
    imports,
    '',
    `test(${JSON.stringify(testName)}, async () => {`,
    assertion,
    '})',
  ].join('\n')
}

/**
 * Returns the isolated Playwright config shared by generated validation tests.
 *
 * @returns {string} canonical generated Playwright config
 */
function getGeneratedConfigContent () {
  return [
    `const { defineConfig } = require(${JSON.stringify(PLAYWRIGHT_PACKAGE)})`,
    '',
    'module.exports = defineConfig({',
    '  fullyParallel: false,',
    '  forbidOnly: true,',
    "  reporter: 'line',",
    '  retries: 0,',
    '  testDir: __dirname,',
    '  workers: 1,',
    '})',
  ].join('\n')
}

/**
 * Returns the generated Playwright config path for a test directory.
 *
 * @param {string} testDirectory generated test directory
 * @returns {string} generated config path
 */
function getGeneratedConfigPath (testDirectory) {
  return path.join(testDirectory, GENERATED_CONFIG_FILENAME)
}

/**
 * Returns Playwright arguments that select one existing project spec.
 *
 * @param {string} filename selected Playwright spec
 * @returns {string[]} focused Playwright arguments
 */
function getFocusedTestArgs (filename) {
  return [filename, '--reporter=line', '--workers=1']
}

/**
 * Returns Playwright arguments for one isolated generated scenario.
 *
 * @param {string} filename generated Playwright spec
 * @param {string} configFile generated Playwright config
 * @returns {string[]} generated scenario arguments
 */
function getGeneratedTestArgs (filename, configFile) {
  return [
    'test',
    '--config',
    configFile,
    filename,
    '--reporter=line',
    '--workers=1',
  ]
}

/**
 * Extracts the executed-test count from the final Playwright summary.
 *
 * @param {string} output Playwright output without ANSI escapes
 * @returns {number|null} executed test count when present
 */
function getObservedTestCount (output) {
  const observed = sumLastMatchCounts(output, [
    /^\s*(\d+)\s+passed\b/gim,
    /^\s*(\d+)\s+failed\b/gim,
    /^\s*(\d+)\s+flaky\b/gim,
  ])
  if (observed !== null) return observed
  return /^\s*\d+\s+skipped\b/im.test(output) ? 0 : null
}

/**
 * Sums the final count for each Playwright summary pattern.
 *
 * @param {string} output Playwright output
 * @param {RegExp[]} patterns summary patterns
 * @returns {number|null} summed count when any pattern matched
 */
function sumLastMatchCounts (output, patterns) {
  let found = false
  let total = 0
  for (const pattern of patterns) {
    let count
    for (const match of output.matchAll(pattern)) count = Number(match[1])
    if (count === undefined) continue
    found = true
    total += count
  }
  return found ? total : null
}

module.exports = {
  CONFIG_PATTERN,
  getFocusedTestArgs,
  getGeneratedConfigContent,
  getGeneratedConfigPath,
  getGeneratedTestArgs,
  getGeneratedTestContent,
  getObservedTestCount,
  getTestExtension,
  isTestFile,
}
