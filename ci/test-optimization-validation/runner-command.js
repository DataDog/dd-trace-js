'use strict'

const fs = require('node:fs')
const path = require('node:path')

const cucumber = require('./framework-adapters/cucumber')
const cypress = require('./framework-adapters/cypress')
const playwright = require('./framework-adapters/playwright')
const { inheritApprovedExecutable } = require('./executable-approval')

const DEFAULT_TIMEOUT_MS = 180_000
const BROWSER_TIMEOUT_MS = 300_000
const GENERATED_SCENARIO_BY_FEATURE = {
  atr: 'atr-fail-once',
  efd: 'basic-pass',
  'test-management': 'test-management-target',
}

/**
 * Builds the validator-owned direct command for an existing representative test.
 *
 * @param {object} framework normalized framework manifest entry
 * @param {string} [testFile] selected representative test
 * @returns {object} structured direct-runner command
 */
function getBasicCommand (framework, testFile = framework.validation.testFile) {
  return buildCommand(framework, testFile, false)
}

/**
 * Builds the validator-owned direct command for a generated scenario.
 *
 * @param {object} framework normalized framework manifest entry
 * @param {object} scenario generated scenario
 * @returns {object} structured direct-runner command
 */
function getGeneratedCommand (framework, scenario) {
  return buildCommand(framework, scenario.testIdentities[0].file, true)
}

/**
 * Returns every command the approval permits for one framework.
 *
 * @param {object} framework normalized framework manifest entry
 * @param {string|null} [requestedScenario] selected validator scenario
 * @returns {Array<[string, object]>} labeled direct-runner commands
 */
function getFrameworkCommands (framework, requestedScenario = null) {
  if (framework.status !== 'runnable') return []
  if (requestedScenario === 'ci-wiring') return []

  const commands = [['basic-reporting', getBasicCommand(framework)]]
  const fallbackTests = framework.validation.fallbackTests
  if (fallbackTests) {
    for (const [index, fallback] of fallbackTests.entries()) {
      commands.push([`basic-reporting:fallback-${index + 1}`, getBasicCommand(framework, fallback.testFile)])
    }
  }
  const scenarios = framework.generatedTestStrategy?.scenarios
  if (scenarios) {
    for (const scenario of scenarios) {
      if (!shouldIncludeGeneratedScenario(scenario.id, requestedScenario)) continue
      commands.push([`generated:${scenario.id}`, getGeneratedCommand(framework, scenario)])
    }
  }
  return commands
}

/**
 * Returns every command covered by a validation manifest.
 *
 * @param {object} manifest normalized validation manifest
 * @param {string|null} [requestedScenario] selected validator scenario
 * @returns {Array<[string, object]>} labeled direct-runner commands
 */
function getManifestCommands (manifest, requestedScenario = null) {
  const commands = []
  if (manifest.frameworks) {
    for (const framework of manifest.frameworks) {
      for (const [label, command] of getFrameworkCommands(framework, requestedScenario)) {
        commands.push([`${framework.id}:${label}`, command])
      }
    }
  }
  return commands
}

/**
 * Returns existing project files that affect direct validation.
 *
 * @param {object} manifest normalized validation manifest
 * @param {object} [options] file selection options
 * @param {boolean} [options.includeLocal] include local runner inputs
 * @returns {string[]} sorted unique absolute paths
 */
function getManifestInputFiles (manifest, { includeLocal = true } = {}) {
  const files = new Set()
  if (manifest.frameworks) {
    for (const framework of manifest.frameworks) {
      addExistingFile(files, framework.ciWiring?.configFile)
      addExistingFile(files, framework.project?.packageJson)
      if (!includeLocal) continue
      if (framework.status !== 'runnable') continue
      addExistingFile(files, framework.validation?.runner)
      addExistingFile(files, framework.validation?.testFile)
      const fallbackTests = framework.validation?.fallbackTests
      if (fallbackTests) {
        for (const fallback of fallbackTests) addExistingFile(files, fallback.testFile)
      }
      const configFiles = framework.project?.configFiles
      if (configFiles) {
        for (const filename of configFiles) addExistingFile(files, filename)
      }
    }
  }
  return [...files].sort()
}

/**
 * Returns whether a generated scenario can execute for the selected feature.
 *
 * @param {string} scenarioId generated scenario id
 * @param {string|null} requestedScenario selected validator scenario
 * @returns {boolean} whether to include the command
 */
function shouldIncludeGeneratedScenario (scenarioId, requestedScenario) {
  if (!requestedScenario) return true
  return GENERATED_SCENARIO_BY_FEATURE[requestedScenario] === scenarioId
}

/**
 * Builds one direct Node.js runner invocation.
 *
 * @param {object} framework normalized framework manifest entry
 * @param {string} testFile selected existing or generated test file
 * @param {boolean} generated whether this is a validator-owned generated test
 * @returns {object} structured command
 */
function buildCommand (framework, testFile, generated) {
  const { runner, requiredEnvVars = [], timeoutMs } = framework.validation
  const outputPaths = framework.framework === 'playwright'
    ? [playwright.getOutputPath(testFile)]
    : []
  const cwd = framework.project.root

  return inheritApprovedExecutable(framework.validation, {
    argv: [process.execPath, runner, ...getRunnerArgs(framework, testFile, generated)],
    cwd,
    description: `${formatFrameworkName(framework.framework)} ${generated ? 'generated' : 'representative'} test`,
    env: getRunnerEnv(framework),
    outputPaths,
    requiredEnvVars,
    timeoutMs: timeoutMs || (framework.browserRequired ? BROWSER_TIMEOUT_MS : DEFAULT_TIMEOUT_MS),
    usesShell: false,
  })
}

/**
 * Returns adapter-owned arguments for one exact test file.
 *
 * @param {object} framework normalized framework manifest entry
 * @param {string} testFile selected existing or generated test file
 * @param {boolean} generated whether this is a validator-owned generated test
 * @returns {string[]} runner arguments
 */
function getRunnerArgs (framework, testFile, generated) {
  const name = framework.framework
  const configuration = framework.validation.runnerArgs || []
  if (name === 'cucumber') {
    if (!generated) return [...configuration, ...cucumber.getFocusedTestArgs(testFile, framework.project.root)]
    return [
      ...configuration,
      ...cucumber.getGeneratedTestArgs(
        testFile,
        cucumber.getGeneratedStepsPath(framework.generatedTestStrategy.testDirectory),
        framework.project.root
      ),
    ]
  }
  if (name === 'cypress') {
    if (generated) return cypress.getGeneratedTestArgs(testFile, configuration)
    return [
      'run',
      ...configuration,
      ...cypress.getFocusedTestArgs(testFile),
      '--config',
      'video=false,screenshotOnRunFailure=false',
    ]
  }
  if (name === 'playwright') {
    if (generated) {
      return playwright.getGeneratedTestArgs(
        testFile,
        playwright.getGeneratedConfigPath(framework.generatedTestStrategy.testDirectory)
      )
    }
    return ['test', ...configuration, ...playwright.getFocusedTestArgs(testFile)]
  }
  if (name === 'jest') {
    const generatedOverrides = []
    if (generated && configuration.some(argument => {
      return argument === '--detectLeaks' || argument === '--detectLeaks=true'
    })) {
      generatedOverrides.push('--detectLeaks=false')
    }
    return [
      ...configuration,
      '--runTestsByPath',
      testFile,
      '--runInBand',
      '--silent',
      '--no-watchman',
      ...generatedOverrides,
    ]
  }
  if (name === 'mocha') {
    return [...configuration, '--no-config', '--no-package', '--no-opts', '--reporter', 'spec', testFile]
  }
  if (name === 'vitest') {
    const needsGlobals = generated && framework.generatedTestStrategy.moduleSystem === 'commonjs'
    return ['run', ...configuration, testFile, ...(needsGlobals ? ['--globals'] : [])]
  }
  throw new Error(`No direct-runner adapter is available for ${name}.`)
}

/**
 * Returns small deterministic environment adjustments owned by an adapter.
 *
 * @param {object} framework framework entry
 * @returns {Record<string, string>} command environment
 */
function getRunnerEnv (framework) {
  return {
    ...framework.validation.environment,
    ...(framework.framework === 'cucumber' ? { CUCUMBER_PUBLISH_QUIET: 'true' } : {}),
  }
}

/**
 * Adds an existing regular file to an approval input set.
 *
 * @param {Set<string>} files collected files
 * @param {string|undefined} filename candidate file
 * @returns {void}
 */
function addExistingFile (files, filename) {
  if (typeof filename !== 'string') return
  try {
    if (fs.statSync(filename).isFile()) files.add(path.resolve(filename))
  } catch {}
}

/**
 * Formats a framework name for command descriptions.
 *
 * @param {string} framework framework name
 * @returns {string} display name
 */
function formatFrameworkName (framework) {
  return framework.charAt(0).toUpperCase() + framework.slice(1)
}

module.exports = {
  getBasicCommand,
  getFrameworkCommands,
  getGeneratedCommand,
  getManifestCommands,
  getManifestInputFiles,
}
