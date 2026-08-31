'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createManifestScaffold } = require('../../../../ci/test-optimization-validation/manifest-scaffold')
const { loadManifest } = require('../../../../ci/test-optimization-validation/manifest-loader')

const WINDOWS_SEQUENCE_NUMBER = 1024n

const FRAMEWORKS = {
  cucumber: {
    bin: 'cucumber-js',
    packageName: '@cucumber/cucumber',
    testFile: 'features/example.feature',
    testSource: 'Feature: example\n\n  Scenario: works\n    Given it works\n',
    version: '8.11.1',
  },
  cypress: {
    bin: 'cypress',
    packageName: 'cypress',
    testFile: 'cypress/e2e/example.cy.js',
    testSource: "describe('example', () => { it('works', () => { expect(true).to.equal(true) }) })\n",
    version: '13.17.0',
  },
  jest: {
    bin: 'jest',
    packageName: 'jest',
    testFile: 'test/example.test.js',
    testSource: "test('works', () => { expect(true).toBe(true) })\n",
    version: '29.7.0',
  },
  mocha: {
    bin: 'mocha',
    packageName: 'mocha',
    testFile: 'test/example.spec.js',
    testSource: "describe('example', () => { it('works', () => {}) })\n",
    version: '10.8.2',
  },
  playwright: {
    bin: 'playwright',
    packageName: '@playwright/test',
    testFile: 'tests/example.spec.js',
    testSource: "const { test } = require('@playwright/test')\ntest('works', async () => {})\n",
    version: '1.48.0',
  },
  vitest: {
    bin: 'vitest',
    packageName: 'vitest',
    testFile: 'test/example.test.js',
    testSource: "import { test, expect } from 'vitest'\ntest('works', () => expect(true).toBe(true))\n",
    version: '2.1.9',
  },
}

/**
 * Creates a small installed-framework repository fixture.
 *
 * @param {object} [options] fixture options
 * @param {string} [options.framework] framework name
 * @param {string} [options.ciSource] GitHub Actions source
 * @param {string} [options.runnerSource] runner JavaScript source
 * @param {string} [options.script] package test script
 * @param {string} [options.testSource] representative test source
 * @returns {{definition: object, root: string, runner: string, testFile: string}} fixture
 */
function createRepositoryFixture ({
  framework = 'mocha',
  ciSource,
  runnerSource = 'void 0\n',
  script,
  testSource,
} = {}) {
  const definition = FRAMEWORKS[framework]
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `dd-validation-${framework}-`)))
  const packageRoot = path.join(root, 'node_modules', ...definition.packageName.split('/'))
  const runner = path.join(packageRoot, 'bin', `${definition.bin}.js`)
  const testFile = path.join(root, definition.testFile)
  fs.mkdirSync(path.dirname(runner), { recursive: true })
  fs.mkdirSync(path.dirname(testFile), { recursive: true })
  fs.writeFileSync(runner, runnerSource)
  fs.writeFileSync(testFile, testSource || definition.testSource)
  fs.writeFileSync(path.join(packageRoot, 'package.json'), `${JSON.stringify({
    name: definition.packageName,
    version: definition.version,
    bin: { [definition.bin]: `bin/${definition.bin}.js` },
  })}\n`)
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({
    name: `${framework}-fixture`,
    devDependencies: { [definition.packageName]: definition.version },
    scripts: { test: script || `${definition.bin} ${definition.testFile}` },
  })}\n`)
  if (ciSource !== undefined) {
    const workflow = path.join(root, '.github', 'workflows', 'test.yml')
    fs.mkdirSync(path.dirname(workflow), { recursive: true })
    fs.writeFileSync(workflow, ciSource)
  }
  return { definition, root, runner, testFile }
}

/**
 * Creates and reloads a manifest through the production parser.
 *
 * @param {string} root fixture repository root
 * @param {string} framework framework name
 * @returns {object} loaded manifest
 */
function createLoadedManifest (root, framework) {
  const manifest = createManifestScaffold({ root, frameworks: new Set([framework]) })
  const manifestPath = path.join(root, 'dd-test-optimization-validation-manifest.json')
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return loadManifest(manifestPath)
}

/**
 * Removes a fixture repository.
 *
 * @param {string} root fixture root
 * @returns {void}
 */
function removeFixture (root) {
  fs.rmSync(root, { force: true, recursive: true })
}

function withRepositoryFixture (options, callback) {
  const fixture = createRepositoryFixture(options)
  try {
    return callback(fixture)
  } finally {
    removeFixture(fixture.root)
  }
}

/**
 * Emulates a volume whose file reference numbers carry a Windows sequence number above the 48-bit
 * file index, so distinct paths round to one number outside the safe integer range.
 *
 * @param {Partial<import('node:fs')>} [overrides] further `node:fs` members to replace
 * @returns {Partial<import('node:fs')>} `node:fs` replacement for proxyquire
 */
function createWindowsFileReferenceFs (overrides) {
  const references = new Map()

  /**
   * @param {import('node:fs').Stats | import('node:fs').BigIntStats} stat real path status
   * @param {boolean} [bigint] whether the caller asked for bigint values
   */
  const toWindowsStat = (stat, bigint) => {
    const key = String(stat.ino)
    if (!references.has(key)) {
      references.set(key, (WINDOWS_SEQUENCE_NUMBER << 48n) + BigInt(references.size))
    }
    const reference = references.get(key)
    const windowsStat = { ...stat, ino: bigint ? reference : Number(reference) }
    windowsStat.isDirectory = () => stat.isDirectory()
    windowsStat.isFile = () => stat.isFile()
    windowsStat.isSymbolicLink = () => stat.isSymbolicLink()
    return windowsStat
  }

  return {
    lstatSync: (target, options) => toWindowsStat(fs.lstatSync(target, options), options?.bigint),
    statSync: (target, options) => toWindowsStat(fs.statSync(target, options), options?.bigint),
    ...overrides,
  }
}

module.exports = {
  FRAMEWORKS,
  createLoadedManifest,
  createRepositoryFixture,
  createWindowsFileReferenceFs,
  removeFixture,
  withRepositoryFixture,
}
