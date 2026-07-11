'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { describe, it, beforeEach, afterEach } = require('mocha')

const { getApplicationOtelApiPackages } = require('../src/helpers/otel-api-externals')

describe('otel-api-externals', () => {
  let temporaryDirectory
  let workingDirectory

  beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-otel-externals-'))
    workingDirectory = temporaryDirectory
  })

  afterEach(() => {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  })

  /**
   * @param {Record<string, string | Record<string, string>>} manifest
   * @returns {void}
   */
  function writeManifest (manifest) {
    fs.writeFileSync(path.join(workingDirectory, 'package.json'), JSON.stringify(manifest))
  }

  /**
   * @param {string} name
   * @param {string} version
   * @param {string} [directory]
   */
  function installPackage (name, version, directory = workingDirectory) {
    const packageDirectory = path.join(directory, 'node_modules', ...name.split('/'))
    fs.mkdirSync(packageDirectory, { recursive: true })
    fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({
      name,
      version,
      main: 'index.js',
    }))
    fs.writeFileSync(path.join(packageDirectory, 'index.js'), 'module.exports = {}\n')
  }

  function getPackageNames () {
    return [...getApplicationOtelApiPackages(workingDirectory).keys()]
  }

  it('externalizes only the packages the application declares', () => {
    writeManifest({ name: 'app', dependencies: { '@opentelemetry/api': '^1.9.0' } })
    installPackage('@opentelemetry/api', '1.9.0')

    assert.deepStrictEqual(getPackageNames(), ['@opentelemetry/api'])
  })

  it('bundles every package the application does not declare', () => {
    writeManifest({ name: 'app', dependencies: { express: '^4.0.0' } })
    installPackage('@opentelemetry/api', '1.9.0')

    assert.deepStrictEqual(getPackageNames(), [])
  })

  for (const dependencyField of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    it(`detects packages in ${dependencyField}`, () => {
      writeManifest({
        name: 'app',
        [dependencyField]: { '@opentelemetry/api': '^1.9.0' },
      })
      installPackage('@opentelemetry/api', '1.9.0')

      assert.deepStrictEqual(getPackageNames(), ['@opentelemetry/api'])
    })
  }

  it('bundles a declared package that is not installed', () => {
    writeManifest({ name: 'app', dependencies: { '@opentelemetry/api': '^1.9.0' } })

    assert.deepStrictEqual(getPackageNames(), [])
  })

  for (const [packageName, acceptedVersion, rejectedVersion] of [
    ['@opentelemetry/api', '1.9.999', '1.10.0'],
    ['@opentelemetry/api-logs', '0.999.999', '1.0.0'],
  ]) {
    it(`externalizes supported ${packageName} versions`, () => {
      writeManifest({ name: 'app', dependencies: { [packageName]: acceptedVersion } })
      installPackage(packageName, acceptedVersion)

      assert.deepStrictEqual(getPackageNames(), [packageName])
    })

    it(`bundles unsupported ${packageName} versions`, () => {
      writeManifest({ name: 'app', dependencies: { [packageName]: rejectedVersion } })
      installPackage(packageName, rejectedVersion)

      assert.deepStrictEqual(getPackageNames(), [])
    })
  }

  for (const [packageName, acceptedVersion, rejectedVersion] of [
    ['@opentelemetry/api', '1.0.0', '0.999.999'],
    ['@opentelemetry/api-logs', '0.33.0', '0.32.999'],
  ]) {
    it(`externalizes ${packageName} at its minimum supported version`, () => {
      writeManifest({ name: 'app', dependencies: { [packageName]: acceptedVersion } })
      installPackage(packageName, acceptedVersion)

      assert.deepStrictEqual(getPackageNames(), [packageName])
    })

    it(`bundles ${packageName} immediately below its minimum supported version`, () => {
      writeManifest({ name: 'app', dependencies: { [packageName]: rejectedVersion } })
      installPackage(packageName, rejectedVersion)

      assert.deepStrictEqual(getPackageNames(), [])
    })
  }

  it('finds a declared workspace dependency in an ancestor manifest', () => {
    fs.writeFileSync(path.join(temporaryDirectory, 'package.json'), JSON.stringify({
      name: 'workspace',
      dependencies: { '@opentelemetry/api': '^1.9.0' },
    }))
    installPackage('@opentelemetry/api', '1.9.0', temporaryDirectory)
    workingDirectory = path.join(temporaryDirectory, 'packages', 'app')
    fs.mkdirSync(workingDirectory, { recursive: true })
    writeManifest({ name: 'app' })

    assert.deepStrictEqual(getPackageNames(), ['@opentelemetry/api'])
  })

  it('bundles every package when the manifest cannot be read', () => {
    assert.deepStrictEqual(getPackageNames(), [])
  })

  it('bundles every package when the manifest is malformed', () => {
    fs.writeFileSync(path.join(workingDirectory, 'package.json'), '{')

    assert.deepStrictEqual(getPackageNames(), [])
  })
})
