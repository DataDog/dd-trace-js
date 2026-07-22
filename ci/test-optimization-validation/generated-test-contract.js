'use strict'

const path = require('node:path')

const cucumberAdapter = require('./framework-adapters/cucumber')
const cypressAdapter = require('./framework-adapters/cypress')
const playwrightAdapter = require('./framework-adapters/playwright')

const GENERATED_SCENARIOS = {
  'basic-pass': {
    purpose: 'basic_reporting|efd_candidate',
    testName: 'basic-pass',
  },
  'atr-fail-once': {
    purpose: 'auto_test_retries_candidate',
    testName: 'atr-fail-once',
  },
  'test-management-target': {
    purpose: 'test_management_candidate',
    testName: 'test-management-target',
  },
}

/**
 * Returns validator-owned source for one generated scenario.
 *
 * @param {object} input generated source input
 * @param {string} input.framework test framework
 * @param {string} input.moduleSystem generated module system
 * @param {string} input.scenarioId generated scenario id
 * @param {string} [input.stateFile] persistent ATR state file
 * @returns {string} canonical generated source
 */
function getGeneratedTestContent ({ framework, moduleSystem, scenarioId, stateFile }) {
  const scenario = GENERATED_SCENARIOS[scenarioId]
  if (!scenario) throw new Error(`Unknown generated Test Optimization scenario: ${scenarioId}`)
  if (framework === 'cucumber') {
    return cucumberAdapter.getGeneratedTestContent({ testName: scenario.testName })
  }
  if (framework === 'cypress') {
    return cypressAdapter.getGeneratedTestContent({
      scenarioId,
      testName: scenario.testName,
    })
  }
  if (framework === 'playwright') {
    return playwrightAdapter.getGeneratedTestContent({
      scenarioId,
      testName: scenario.testName,
    })
  }

  const imports = []
  if (framework === 'vitest' && moduleSystem === 'esm') {
    imports.push("import { describe, expect, it } from 'vitest'")
  }
  if (framework === 'mocha') {
    imports.push(moduleSystem === 'esm'
      ? "import assert from 'node:assert/strict'"
      : "const assert = require('node:assert/strict')")
  }
  if (scenarioId === 'atr-fail-once') {
    if (moduleSystem === 'esm') {
      imports.push("import { existsSync, writeFileSync } from 'node:fs'")
    } else {
      imports.push("const fs = require('node:fs')")
    }
  }

  const assertion = framework === 'mocha' ? 'assert.equal(1, 1)' : 'expect(true).toBe(true)'
  const testFunction = framework === 'jest' ? 'test' : 'it'
  const body = scenarioId === 'atr-fail-once'
    ? getAtrBody({ moduleSystem, assertion, stateFile })
    : `    ${assertion}`

  return [
    ...imports,
    imports.length > 0 ? '' : undefined,
    "describe('dd-test-optimization-validation', () => {",
    `  ${testFunction}('${scenario.testName}', () => {`,
    body,
    '  })',
    '})',
  ].filter(line => line !== undefined).join('\n')
}

/**
 * Verifies that a runnable framework retained the validator-owned generated-test recipe.
 *
 * @param {object} framework manifest framework entry
 * @returns {string|undefined} contract error
 */
function getGeneratedTestContractError (framework) {
  const strategy = framework.generatedTestStrategy
  if (!strategy || !['planned', 'verified'].includes(strategy.status)) return

  if (!['cucumber', 'cypress', 'jest', 'mocha', 'playwright', 'vitest'].includes(framework.framework)) return
  if (strategy.adapter !== framework.framework) {
    return `must retain generatedTestStrategy.adapter ${JSON.stringify(framework.framework)} so the installed ` +
      'validator, rather than the agent, owns the temporary test source.'
  }
  if (!['commonjs', 'esm'].includes(strategy.moduleSystem)) {
    return 'must retain generatedTestStrategy.moduleSystem as "commonjs" or "esm".'
  }

  const files = strategy.files || []
  const scenarios = strategy.scenarios || []
  const projectRoot = framework.project?.root
  if (typeof projectRoot !== 'string') return 'must declare a project root for generated tests.'
  if ((strategy.cleanupPaths || []).some(filename => typeof filename !== 'string')) {
    return 'must contain only string cleanup paths.'
  }
  const cleanupPaths = new Set((strategy.cleanupPaths || []).map(filename => path.normalize(filename)))
  const expectedFileCount = ['cucumber', 'playwright'].includes(framework.framework) ? 4 : 3
  if (files.length !== expectedFileCount || scenarios.length !== 3) {
    return 'must contain exactly one validator-owned file for each of basic-pass, atr-fail-once, and ' +
      `test-management-target${getAdditionalGeneratedFileDescription(framework.framework)}.`
  }

  const selectedFiles = new Set()
  for (const [scenarioId, definition] of Object.entries(GENERATED_SCENARIOS)) {
    const scenario = scenarios.find(entry => entry.id === scenarioId)
    if (!scenario) return `is missing the validator-owned ${scenarioId} scenario.`
    if (scenario.testIdentities?.length !== 1) {
      return `scenario ${scenarioId} must declare exactly one generated test identity.`
    }

    const filename = scenario.testIdentities[0].file
    if (typeof filename !== 'string') return `scenario ${scenarioId} must identify a generated test file.`
    if (!isPathInside(projectRoot, filename)) {
      return `scenario ${scenarioId} file must remain inside project root ${projectRoot}.`
    }
    const file = files.find(entry => {
      return typeof entry.path === 'string' && path.normalize(entry.path) === path.normalize(filename)
    })
    if (!file) return `scenario ${scenarioId} must identify exactly one file in generatedTestStrategy.files.`
    selectedFiles.add(path.normalize(filename))
    if (scenario.testIdentities[0].name !== definition.testName) {
      return `scenario ${scenarioId} must retain test name ${JSON.stringify(definition.testName)}.`
    }

    const stateFile = ['cucumber', 'cypress', 'playwright'].includes(framework.framework)
      ? undefined
      : path.join(path.dirname(filename), '.dd-test-optimization-validation-atr-state')
    const expectedSource = getGeneratedTestContent({
      framework: framework.framework,
      moduleSystem: strategy.moduleSystem,
      scenarioId,
      stateFile,
    })
    if (file.contentLines?.join('\n') !== expectedSource) {
      return `scenario ${scenarioId} source differs from the validator-owned ${framework.framework} recipe. ` +
        'Regenerate the manifest scaffold instead of rewriting temporary tests.'
    }
    if (!cleanupPaths.has(path.normalize(filename))) {
      return `scenario ${scenarioId} file must be included in generatedTestStrategy.cleanupPaths.`
    }
    if (!commandReferencesFile(scenario.runCommand, filename)) {
      return `scenario ${scenarioId} runCommand does not select its declared generated test file.`
    }
  }

  if (framework.framework === 'cucumber') {
    const stepsFile = cucumberAdapter.getGeneratedStepsPath(strategy.testDirectory)
    const steps = files.find(file => path.normalize(file.path) === path.normalize(stepsFile))
    if (steps?.contentLines?.join('\n') !== cucumberAdapter.getGeneratedStepsContent()) {
      return 'must retain the validator-owned Cucumber step definitions.'
    }
    if (!cleanupPaths.has(path.normalize(stepsFile))) {
      return 'must include the isolated Cucumber step definitions in cleanupPaths.'
    }
    if (scenarios.some(scenario => !commandReferencesFile(scenario.runCommand, stepsFile))) {
      return 'each Cucumber scenario runCommand must select the isolated generated step definitions.'
    }
  }

  if (framework.framework === 'playwright') {
    const configPath = playwrightAdapter.getGeneratedConfigPath(strategy.testDirectory)
    const config = files.find(file => path.normalize(file.path) === path.normalize(configPath))
    if (config?.contentLines?.join('\n') !== playwrightAdapter.getGeneratedConfigContent()) {
      return 'must retain the validator-owned isolated Playwright config.'
    }
    if (!cleanupPaths.has(path.normalize(configPath))) {
      return 'must include the isolated Playwright config in generatedTestStrategy.cleanupPaths.'
    }
    if (scenarios.some(scenario => !commandReferencesFile(scenario.runCommand, configPath))) {
      return 'each Playwright scenario runCommand must select the isolated generated config.'
    }
  }

  const usesPersistentRetryState = !['cucumber', 'cypress', 'playwright'].includes(framework.framework)
  if (usesPersistentRetryState) {
    const atrScenario = scenarios.find(entry => entry.id === 'atr-fail-once')
    const stateFile = path.join(
      path.dirname(atrScenario.testIdentities[0].file),
      '.dd-test-optimization-validation-atr-state'
    )
    if (!cleanupPaths.has(path.normalize(stateFile))) {
      return `scenario atr-fail-once must clean up its persistent retry state file ${stateFile}.`
    }
  }
  const expectedCleanupPathCount = usesPersistentRetryState ? 4 : expectedFileCount
  if (selectedFiles.size !== 3 || cleanupPaths.size !== expectedCleanupPathCount) {
    if (framework.framework === 'cucumber') {
      return 'must use three distinct generated feature files and clean up those files plus the isolated Cucumber ' +
        'step definitions.'
    }
    return usesPersistentRetryState
      ? 'must use three distinct generated test files and clean up exactly those files plus the persistent ATR ' +
        'state file.'
      : 'must use three distinct generated test files and clean up exactly those files.'
  }
}

/**
 * Describes adapter-specific files in generated-contract errors.
 *
 * @param {string} framework framework name
 * @returns {string} additional file description
 */
function getAdditionalGeneratedFileDescription (framework) {
  if (framework === 'cucumber') return ' plus isolated Cucumber step definitions'
  if (framework === 'playwright') return ' plus one isolated Playwright config'
  return ''
}

/**
 * Checks whether a generated path is inside or equal to the declared project root.
 *
 * @param {string} root project root
 * @param {string} filename generated path
 * @returns {boolean} whether the path is contained
 */
function isPathInside (root, filename) {
  const relative = path.relative(path.resolve(root), path.resolve(filename))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Reports whether a structured command visibly selects a generated file.
 *
 * @param {object} command structured command
 * @param {string} filename generated file
 * @returns {boolean} whether the command selects the file
 */
function commandReferencesFile (command, filename) {
  const values = command?.usesShell
    ? String(command.shellCommand || '').match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map(value => {
      return value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2')
    }) || []
    : command?.argv || []
  return values.some(value => {
    if (typeof value !== 'string') return false
    let pathValue = value.startsWith('--') && value.includes('=') ? value.slice(value.indexOf('=') + 1) : value
    pathValue = pathValue.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2')
    return path.resolve(command.cwd, pathValue) === path.resolve(filename)
  })
}

/**
 * Returns the persistent retry body used across independent test-runner processes.
 *
 * @param {object} input body input
 * @param {string} input.moduleSystem generated module system
 * @param {string} input.assertion passing assertion
 * @param {string} input.stateFile persistent ATR state file
 * @returns {string} retry test body
 */
function getAtrBody ({ moduleSystem, assertion, stateFile }) {
  if (typeof stateFile !== 'string' || !path.isAbsolute(stateFile)) {
    throw new Error('The validator-owned ATR recipe requires an absolute persistent state file path.')
  }
  const exists = moduleSystem === 'esm' ? 'existsSync' : 'fs.existsSync'
  const write = moduleSystem === 'esm' ? 'writeFileSync' : 'fs.writeFileSync'
  return [
    `    const stateFile = ${JSON.stringify(stateFile)}`,
    `    if (!${exists}(stateFile)) {`,
    `      ${write}(stateFile, 'failed-once')`,
    "      throw new Error('dd-test-optimization-validation atr first failure')",
    '    }',
    `    ${assertion}`,
  ].join('\n')
}

module.exports = {
  GENERATED_SCENARIOS,
  getGeneratedTestContent,
  getGeneratedTestContractError,
}
