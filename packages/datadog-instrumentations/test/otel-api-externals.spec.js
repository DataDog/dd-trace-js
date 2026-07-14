'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { describe, it, beforeEach, afterEach } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const {
  createApplicationOtelApiPackageResolver,
  getApplicationOtelApiPackages,
} = require('../src/helpers/otel-api-externals')

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

  it('resolves an ancestor declaration from the manifest that owns it', () => {
    fs.writeFileSync(path.join(temporaryDirectory, 'package.json'), JSON.stringify({
      name: 'workspace',
      dependencies: { '@opentelemetry/api': '^1.9.0' },
    }))
    installPackage('@opentelemetry/api', '1.9.0', temporaryDirectory)
    workingDirectory = path.join(temporaryDirectory, 'packages', 'app')
    fs.mkdirSync(workingDirectory, { recursive: true })
    writeManifest({ name: 'app' })
    installPackage('@opentelemetry/api', '1.9.0')

    assert.deepStrictEqual(
      getApplicationOtelApiPackages(workingDirectory).get('@opentelemetry/api'),
      {
        moduleBaseDir: fs.realpathSync(path.join(
          temporaryDirectory,
          'node_modules',
          '@opentelemetry',
          'api'
        )),
      }
    )
  })

  it('resolves dependencies declared by a workspace package below the build root', () => {
    writeManifest({ name: 'workspace', private: true })
    const applicationDirectory = path.join(temporaryDirectory, 'packages', 'app')
    fs.mkdirSync(applicationDirectory, { recursive: true })
    fs.writeFileSync(path.join(applicationDirectory, 'package.json'), JSON.stringify({
      name: 'app',
      dependencies: { '@opentelemetry/api': '^1.9.0' },
    }))
    installPackage('@opentelemetry/api', '1.9.0', applicationDirectory)
    const resolvePackages = createApplicationOtelApiPackageResolver(workingDirectory)

    assert.deepStrictEqual([...resolvePackages().keys()], [])
    assert.deepStrictEqual([...resolvePackages(applicationDirectory).keys()], ['@opentelemetry/api'])
  })

  it('does not treat a transitive dependency declaration as application ownership', () => {
    writeManifest({ name: 'app', private: true })
    const dependencyDirectory = path.join(temporaryDirectory, 'node_modules', 'dependency')
    fs.mkdirSync(dependencyDirectory, { recursive: true })
    fs.writeFileSync(path.join(dependencyDirectory, 'package.json'), JSON.stringify({
      name: 'dependency',
      dependencies: { '@opentelemetry/api': '^1.9.0' },
    }))
    installPackage('@opentelemetry/api', '1.9.0', dependencyDirectory)
    const resolvePackages = createApplicationOtelApiPackageResolver(workingDirectory)

    assert.deepStrictEqual([...resolvePackages(dependencyDirectory).keys()], [])
  })

  it('uses build-root ownership for importers outside the build root', () => {
    writeManifest({ dependencies: { '@opentelemetry/api': '^1.9.0' } })
    installPackage('@opentelemetry/api', '1.9.0')
    const resolvePackages = createApplicationOtelApiPackageResolver(workingDirectory)

    assert.deepStrictEqual([...resolvePackages(path.dirname(temporaryDirectory)).keys()], ['@opentelemetry/api'])
  })

  it('normalizes Windows package paths for bundler ownership metadata', () => {
    const readFileSync = sinon.stub()
    readFileSync
      .withArgs(path.join('/app', 'package.json'), 'utf8')
      .returns(JSON.stringify({ dependencies: { '@opentelemetry/api': '^1.9.0' } }))
    readFileSync
      .withArgs('C:/app/node_modules/@opentelemetry/api/package.json', 'utf8')
      .returns(JSON.stringify({ version: '1.9.0' }))
    const { getApplicationOtelApiPackages } = proxyquire.noPreserveCache()(
      '../src/helpers/otel-api-externals',
      {
        'node:fs': { readFileSync },
        'node:module': {
          createRequire: () => ({
            resolve: () => 'C:\\app\\node_modules\\@opentelemetry\\api\\index.js',
          }),
        },
      }
    )

    assert.deepStrictEqual(getApplicationOtelApiPackages('/app').get('@opentelemetry/api'), {
      moduleBaseDir: 'C:/app/node_modules/@opentelemetry/api',
    })
  })

  it('canonicalizes symlinked module paths', () => {
    writeManifest({ dependencies: { '@opentelemetry/api': '^1.9.0' } })
    const targetRoot = path.join(temporaryDirectory, 'linked')
    installPackage('@opentelemetry/api', '1.9.0', targetRoot)
    const target = path.join(targetRoot, 'node_modules', '@opentelemetry', 'api')
    const scope = path.join(workingDirectory, 'node_modules', '@opentelemetry')
    fs.mkdirSync(scope, { recursive: true })
    fs.symlinkSync(target, path.join(scope, 'api'), process.platform === 'win32' ? 'junction' : 'dir')

    assert.deepStrictEqual(getApplicationOtelApiPackages(workingDirectory).get('@opentelemetry/api'), {
      moduleBaseDir: fs.realpathSync(target).replaceAll('\\', '/'),
    })
  })

  it('bundles every package when the manifest cannot be read', () => {
    assert.deepStrictEqual(getPackageNames(), [])
  })

  it('bundles every package when the manifest is malformed', () => {
    fs.writeFileSync(path.join(workingDirectory, 'package.json'), '{')

    assert.deepStrictEqual(getPackageNames(), [])
  })
})
