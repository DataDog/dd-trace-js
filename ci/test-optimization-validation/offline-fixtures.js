'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createFileSafely, ensureSafeDirectory } = require('./safe-files')

const MAX_FIXTURE_FILE_BYTES = 1024 * 1024
const OFFLINE_FIXTURE_NONCE_PATTERN = /^[a-f0-9]{32}$/
const DEFAULT_SETTINGS = {
  code_coverage: false,
  tests_skipping: false,
  itr_enabled: false,
  require_git: false,
  early_flake_detection: {
    enabled: false,
    slow_test_retries: {
      '5s': 3,
    },
    faulty_session_threshold: 100,
  },
  flaky_test_retries_enabled: false,
  di_enabled: false,
  known_tests_enabled: false,
  test_management: {
    enabled: false,
  },
  impacted_tests_enabled: false,
  coverage_report_upload_enabled: false,
}

/**
 * Creates one validator-controlled cache fixture outside the repository.
 *
 * @param {object} input fixture inputs
 * @param {string} input.approvedPlanSha256 approved execution-plan digest
 * @param {string} input.offlineFixtureNonce random fixture-root nonce from the approved plan
 * @param {object} input.framework framework manifest entry
 * @param {string} input.repositoryRoot repository checkout root
 * @param {string} input.scenarioName unique scenario execution name
 * @param {object} [input.settings] scenario settings overrides
 * @param {object} [input.knownTests] known-tests fixture contents
 * @param {object[]} [input.skippableTests] skippable-tests fixture contents
 * @param {object} [input.testManagementTests] managed-tests fixture contents
 * @returns {{manifestPath: string, root: string, files: object[]}} fixture details
 */
function createOfflineFixture ({
  approvedPlanSha256,
  offlineFixtureNonce,
  framework,
  repositoryRoot,
  scenarioName,
  settings,
  knownTests = {},
  skippableTests = [],
  testManagementTests = {},
}) {
  if (!/^[a-f0-9]{64}$/.test(approvedPlanSha256 || '')) {
    throw new Error('Offline validation requires an approved plan digest before creating fixtures.')
  }
  if (!OFFLINE_FIXTURE_NONCE_PATTERN.test(offlineFixtureNonce || '')) {
    throw new Error('Offline validation requires the fixture nonce from the approved execution plan.')
  }

  const { base, root } = getOfflineFixturePaths({ offlineFixtureNonce, framework, scenarioName })
  if (isPathInside(path.resolve(repositoryRoot), base)) {
    throw new Error('Offline validation fixtures must be outside the repository checkout.')
  }
  ensurePrivateDirectory(base)
  if (fs.existsSync(root)) {
    throw new Error(`Offline validation fixture already exists and will not be replaced: ${root}`)
  }
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    ensureSafeDirectory(base, root, 'offline validation fixture directory')

    const testOptimizationRoot = path.join(root, '.testoptimization')
    const cacheRoot = path.join(testOptimizationRoot, 'cache', 'http')
    fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 })
    ensureSafeDirectory(root, cacheRoot, 'offline validation cache directory')

    const manifestPath = path.join(testOptimizationRoot, 'manifest.txt')
    const fixtureFiles = [
      [manifestPath, '1\n'],
      [path.join(cacheRoot, 'settings.json'), JSON.stringify({
        data: { attributes: mergeSettings(settings) },
      })],
      [path.join(cacheRoot, 'known_tests.json'), JSON.stringify({
        data: { attributes: { tests: knownTests } },
      })],
      [path.join(cacheRoot, 'skippable_tests.json'), JSON.stringify({
        data: skippableTests,
        meta: { correlation_id: 'dd-test-optimization-validation' },
      })],
      [path.join(cacheRoot, 'test_management.json'), JSON.stringify({
        data: { attributes: { modules: testManagementTests } },
      })],
    ]

    for (const [filename, content] of fixtureFiles) {
      if (Buffer.byteLength(content) > MAX_FIXTURE_FILE_BYTES) {
        throw new Error(`Offline validation fixture exceeds ${MAX_FIXTURE_FILE_BYTES} bytes: ${filename}`)
      }
      createFileSafely(root, filename, content, 'offline validation fixture')
    }

    return {
      manifestPath,
      root,
      files: fixtureFiles.map(([filename, content]) => ({ filename, bytes: Buffer.byteLength(content) })),
    }
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true })
    removeEmptyParents(path.dirname(root), base)
    throw error
  }
}

/**
 * Returns random, validator-controlled fixture paths bound to an approved execution plan.
 *
 * @param {object} input fixture path inputs
 * @param {string} input.offlineFixtureNonce random fixture-root nonce from the approved plan
 * @param {object} input.framework framework manifest entry
 * @param {string} input.scenarioName scenario execution name
 * @returns {{base: string, root: string}} fixture base and scenario root
 */
function getOfflineFixturePaths ({ offlineFixtureNonce, framework, scenarioName }) {
  if (!OFFLINE_FIXTURE_NONCE_PATTERN.test(offlineFixtureNonce || '')) {
    throw new Error('Invalid offline validation fixture nonce.')
  }
  const base = path.join(fs.realpathSync(os.tmpdir()), `dd-test-optimization-validation-${offlineFixtureNonce}`)
  return {
    base,
    root: path.join(base, sanitize(framework.id), sanitize(scenarioName)),
  }
}

/**
 * Returns the cache executions selected by a validator scenario selection.
 *
 * @param {string|null|undefined} requestedScenario selected validation scenario
 * @returns {string[]} cache execution names
 */
function getOfflineScenarioNames (requestedScenario) {
  const scenarios = new Set(['basic-reporting', 'basic-reporting-debug'])
  if (!requestedScenario || requestedScenario === 'ci-wiring') scenarios.add('ci-wiring')
  const advanced = requestedScenario
    ? requestedScenario === 'basic-reporting' || requestedScenario === 'ci-wiring'
      ? []
      : [requestedScenario]
    : ['efd', 'atr', 'test-management']
  for (const scenario of advanced) {
    scenarios.add(`${scenario}-baseline`)
    scenarios.add(scenario)
    scenarios.add(`${scenario}-debug`)
  }
  return [...scenarios]
}

/**
 * Hashes the validator-controlled inputs used to build one scenario fixture.
 *
 * @param {object} framework framework manifest entry
 * @param {string} scenarioName cache execution name
 * @returns {string} SHA-256 fixture recipe digest
 */
function getFixtureRecipeDigest (framework, scenarioName) {
  const generatedScenarioId = {
    atr: 'atr-fail-once',
    efd: 'basic-pass',
    'test-management': 'test-management-target',
  }[scenarioName.replace(/-(?:baseline|debug)$/, '')]
  const recipe = {
    version: 1,
    framework: framework.framework,
    scenarioName,
    defaultSettings: DEFAULT_SETTINGS,
    settingsOverrides: getFixtureSettingsOverrides(scenarioName),
    testIdentities: framework.generatedTestStrategy?.scenarios?.find(scenario => {
      return scenario.id === generatedScenarioId
    })?.testIdentities || [],
    dynamicTestManagementIdentity: scenarioName.startsWith('test-management'),
  }
  return crypto.createHash('sha256').update(JSON.stringify(recipe)).digest('hex')
}

/**
 * Returns stable fixture recipe hashes included directly in the approval scope.
 *
 * @param {object} input recipe selection
 * @param {object[]} input.frameworks normalized manifest framework entries
 * @param {string[]} [input.selectedFrameworkIds] selected framework ids
 * @param {string|null} [input.requestedScenario] selected validation scenario
 * @returns {object[]} fixture recipe identities and hashes
 */
function getFixtureRecipeDigests ({ frameworks, selectedFrameworkIds = [], requestedScenario = null }) {
  const selected = new Set(selectedFrameworkIds)
  const entries = []
  for (const framework of frameworks) {
    if (framework.status !== 'runnable' || (selected.size > 0 && !selected.has(framework.id))) continue
    for (const scenarioName of getOfflineScenarioNames(requestedScenario)) {
      entries.push({
        frameworkId: framework.id,
        scenarioName,
        sha256: getFixtureRecipeDigest(framework, scenarioName),
      })
    }
  }
  return entries
}

function getFixtureSettingsOverrides (scenarioName) {
  if (scenarioName === 'atr' || scenarioName === 'atr-debug') {
    return { flaky_test_retries_enabled: true }
  }
  if (scenarioName === 'efd' || scenarioName === 'efd-debug') {
    return {
      early_flake_detection: {
        enabled: true,
        slow_test_retries: { '5s': 3 },
        faulty_session_threshold: 100,
      },
      known_tests_enabled: true,
    }
  }
  if (scenarioName === 'test-management' || scenarioName === 'test-management-debug') {
    return { test_management: { enabled: true, attempt_to_fix_retries: 2 } }
  }
  return {}
}

/**
 * Removes a scenario fixture after its command has exited and output has been read.
 *
 * @param {string} fixtureRoot scenario fixture root
 */
function cleanupOfflineFixture (fixtureRoot) {
  const parent = path.dirname(path.dirname(fixtureRoot))
  ensureSafeDirectory(parent, fixtureRoot, 'offline validation fixture cleanup')
  fs.rmSync(fixtureRoot, { recursive: true })
  removeEmptyParents(path.dirname(fixtureRoot), parent)
}

function mergeSettings (settings = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    early_flake_detection: {
      ...DEFAULT_SETTINGS.early_flake_detection,
      ...settings.early_flake_detection,
    },
    test_management: {
      ...DEFAULT_SETTINGS.test_management,
      ...settings.test_management,
    },
  }
}

/**
 * Creates or verifies a private validator-owned fixture directory.
 *
 * @param {string} directory fixture base directory
 * @returns {void}
 */
function ensurePrivateDirectory (directory) {
  try {
    fs.mkdirSync(directory, { mode: 0o700 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  const stat = fs.lstatSync(directory)
  const ownerMismatch = process.getuid && stat.uid !== process.getuid()
  if (!stat.isDirectory() || stat.isSymbolicLink() || ownerMismatch || (stat.mode & 0o077) !== 0) {
    throw new Error(`Offline validation fixture base is not a regular directory: ${directory}`)
  }
}

/**
 * Removes empty directories up to and including the fixture base.
 *
 * @param {string} directory first candidate directory
 * @param {string} stop fixture base directory
 * @returns {void}
 */
function removeEmptyParents (directory, stop) {
  let current = directory
  while (current !== stop && current.startsWith(`${stop}${path.sep}`)) {
    try {
      fs.rmdirSync(current)
    } catch {
      return
    }
    current = path.dirname(current)
  }
  try {
    fs.rmdirSync(stop)
  } catch {}
}

/**
 * Converts a manifest identifier into a bounded path segment.
 *
 * @param {string} value identifier
 * @returns {string} safe path segment
 */
function sanitize (value) {
  return String(value).replaceAll(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 100)
}

/**
 * Checks lexical path containment.
 *
 * @param {string} root candidate parent
 * @param {string} filename candidate child
 * @returns {boolean} whether the child is inside the parent
 */
function isPathInside (root, filename) {
  const relative = path.relative(root, filename)
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

module.exports = {
  cleanupOfflineFixture,
  createOfflineFixture,
  DEFAULT_SETTINGS,
  getFixtureRecipeDigest,
  getFixtureRecipeDigests,
  getOfflineFixturePaths,
  getOfflineScenarioNames,
  MAX_FIXTURE_FILE_BYTES,
}
