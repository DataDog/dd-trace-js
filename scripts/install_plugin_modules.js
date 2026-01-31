'use strict'

const { createHash } = require('crypto')
const { lstat, mkdir, readdir, writeFile } = require('fs/promises')
const { arch } = require('os')
const { join } = require('path')

const pLimit = require('p-limit')
// eslint-disable-next-line n/no-restricted-require
const semver = require('semver')

const externals = require('../packages/dd-trace/test/plugins/externals.json')
const latests = require('../packages/dd-trace/test/plugins/versions/package.json').dependencies
const { getInstrumentation } = require('../packages/dd-trace/test/setup/helpers/load-inst')
const { getCappedRange } = require('../packages/dd-trace/test/plugins/versions')
const { isRelativeRequire } = require('../packages/datadog-instrumentations/src/helpers/shared-utils')
const exec = require('./helpers/exec')
const requirePackageJsonPath = require.resolve('../packages/dd-trace/src/require-package-json')

// Can remove aerospike after removing support for aerospike < 5.2.0 (for Node.js 22, v5.12.1 is required)
// Can remove couchbase after removing support for couchbase <= 3.2.0
const excludeList = arch() === 'arm64' ? ['aerospike', 'couchbase', 'grpc', 'oracledb'] : []
const workspaces = new Set()
const externalDeps = new Map()
const packagePromises = new Map()
const externalSelfNames = new Set(Object.entries(externals)
  .filter(([key, entries]) => entries.some(entry => entry.name === key))
  .map(([key]) => key))

Object.keys(externals).forEach(external => externals[external].forEach(thing => {
  if (thing.dep) {
    const depsArr = externalDeps.get(external)
    depsArr ? depsArr.push(thing) : externalDeps.set(external, [thing])
  }
}))

run()

async function run () {
  await assertPrerequisites()
  install()
  await assertPeerDependencies(join(__dirname, '..', 'versions'))
  install()
}

async function assertPrerequisites () {
  const filter = process.env.PLUGINS?.split('|')

  const instrumentationFiles = await readdir(join(__dirname, '..', 'packages', 'datadog-instrumentations', 'src'))
  const moduleNames = instrumentationFiles
    .filter(file => file.endsWith('.js'))
    .map(file => file.slice(0, -3))
    .filter(file => !filter || filter.includes(file))

  const internals = moduleNames.reduce((/** @type {object[]} */ internals, moduleName) => {
    internals.push(...getInstrumentation(moduleName))
    return internals
  }, [])

  const limit = pLimit(3)

  await Promise.all(internals.map(inst => limit(() => assertInstrumentation(inst, false))))

  const externalNames = Object.keys(externals).filter(name => moduleNames.includes(name))

  const externalInstrumentations = []
  for (const name of externalNames) {
    for (const inst of externals[name]) {
      externalInstrumentations.push(inst)
    }
  }

  await Promise.all(externalInstrumentations.map(inst => limit(() => assertInstrumentation(inst, true))))

  await assertWorkspaces()
}

/**
 * @param {object} instrumentation
 * @param {boolean} external
 */
async function assertInstrumentation (instrumentation, external) {
  const versions = process.env.PACKAGE_VERSION_RANGE && !external
    ? [process.env.PACKAGE_VERSION_RANGE]
    : [instrumentation.versions || []].flat()

  // Create the unversioned folder (e.g. `versions/bluebird`, `versions/@grpc/proto-loader`) once per module.
  // Some tests depend on it, but creating it for every version key caused concurrent writes corrupting package.json.
  // Prefer the pinned latest version (from `packages/dd-trace/test/plugins/versions/package.json`) when available, to
  // avoid arbitrary selection from an array of ranges (and keep the unversioned folder representing "latest").
  const unversionedVersion = latests[instrumentation.name]
    ? latests[instrumentation.name]
    : (versions.includes('*') ? '*' : versions.find(Boolean))
  if (unversionedVersion) {
    console.log('unversionedVersion', unversionedVersion)
    // If the package is also defined in externals.json as a "self entry" (name === key), prefer the external variant
    // for the unversioned install. This allows yarn to hoist it to `versions/node_modules`, making it available as a
    // peer/optional dependency to other generated packages (e.g. sequelize -> mysql2).
    const unversionedExternal = external || externalSelfNames.has(instrumentation.name)
    await assertPackageOnce(instrumentation.name, null, unversionedVersion, unversionedExternal)
  }

  const versionKeys = new Set()

  for (const version of versions) {
    if (!version) continue

    if (version !== '*') {
      // Only normalize "exact" versions (e.g. "=1.2.3", "v1.2.3") to avoid collapsing distinct semver ranges.
      const cleaned = semver.clean(version)
      console.log('cleaned', cleaned, versionKeys)
      if (cleaned) versionKeys.add(cleaned)
    }

    versionKeys.add(version)
  }

  await Promise.all(
    [...versionKeys].map(versionKey => assertModules(instrumentation.name, versionKey, external))
  )
}

/**
 * @param {string} name
 * @param {string} version
 * @param {boolean} external
 */
async function assertModules (name, version, external) {
  const range = process.env.RANGE
  if (range && !semver.subset(version, range)) return
  await assertPackageOnce(name, version, version, external)
}

/**
 * Memoized wrapper around assertPackage(), keyed by the destination folder path.
 * This avoids concurrent writes to the same `versions/<name>` folder when the same module is processed multiple times.
 *
 * @param {string} name
 * @param {string|null} version
 * @param {string} dependencyVersionRange
 * @param {boolean} external
 * @returns {Promise<void>}
 */
function assertPackageOnce (name, version, dependencyVersionRange, external) {
  const key = folder(name, version)
  const existing = packagePromises.get(key)
  if (existing) return existing

  const promise = assertPackage(name, version, dependencyVersionRange, external)
  packagePromises.set(key, promise)
  return promise
}

/**
 * @param {string|null} [name]
 * @param {string|null} [version]
 */
async function assertFolder (name, version) {
  await mkdir(folder(name, version), { recursive: true })
}

/**
 * @param {string} name
 * @param {string|null} version
 * @param {string} dependencyVersionRange
 * @param {boolean} external
 */
async function assertPackage (name, version, dependencyVersionRange, external) {
  // Early return to prevent filePaths from being installed, their non path counterpars should suffice
  if (isRelativeRequire(name)) return
  const dependencies = {
    [name]: getCappedRange(name, dependencyVersionRange)
  }
  const pkg = {
    name: [name, sha1(name).slice(0, 8), sha1(version)].filter(Boolean).join('-'),
    version: '1.0.0',
    license: 'BSD-3-Clause',
    private: true,
    dependencies
  }

  if (!external) {
    if (name === 'aerospike') {
      pkg.installConfig = {
        hoistingLimits: 'workspaces'
      }
    } else {
      pkg.workspaces = {
        nohoist: ['**/**']
      }
    }
  }

  addFolderToWorkspaces(name, version)
  await assertFolder(name, version)
  await Promise.all([
    writeFile(filename(name, version, 'package.json'), JSON.stringify(pkg, null, 2) + '\n'),
    assertIndex(name, version)
  ])
}

/**
 * @param {object} rootFolder
 * @param {string} parent
 */
async function assertPeerDependencies (rootFolder, parent = '') {
  const entries = await readdir(rootFolder)

  const limit = pLimit(10)

  await Promise.all(entries.map(entry => limit(async () => {
    const folder = join(rootFolder, entry)

    const folderStat = await lstat(folder)
    if (!folderStat.isDirectory()) return
    if (entry === 'node_modules') return
    if (entry.startsWith('@')) {
      await assertPeerDependencies(folder, entry)
      return
    }

    const externalName = join(parent, entry.split('@')[0])

    if (!externalDeps.has(externalName)) return

    const versionPkgJsonPath = join(folder, 'package.json')
    const versionPkgJson = require(versionPkgJsonPath)

    for (const { dep, name, node } of externalDeps.get(externalName)) {
      if (node && !semver.satisfies(process.versions.node, node)) return
      const pkgJsonPath = require(folder).pkgJsonPath()
      const pkgJson = require(pkgJsonPath)

      for (const section of ['devDependencies', 'peerDependencies']) {
        if (pkgJson[section]?.[name]) {
          if (dep === externalName) {
            versionPkgJson.dependencies[name] = pkgJson.version
          } else {
            versionPkgJson.dependencies[name] = pkgJson[section][name].includes('||')
              // Use the first version in the list (as npm does by default)
              ? pkgJson[section][name].split('||')[0].trim()
              // Only one version available so use that.
              : pkgJson[section][name]
          }

          // eslint-disable-next-line no-await-in-loop
          await writeFile(versionPkgJsonPath, JSON.stringify(versionPkgJson, null, 2))

          break
        }
      }
    }
  })))
}

/**
 * @param {string} name
 * @param {string|null} version
 */
async function assertIndex (name, version) {
  const index = `'use strict'

const requirePackageJson = require('${requirePackageJsonPath}')

module.exports = {
  /**
   * Load the module.
   *
   * @param {string} [id] The name/id of the module to get.
   * @returns {import('${name}') | never} The module.
   */
  get (id) { return require(id || '${name}') },
  /**
   * Resolve the path for a module id.
   *
   * @param {string} [id] The module id to resolve.
   * @returns {string | never} The resolved path.
   */
  getPath (id) { return require.resolve(id || '${name}') },
  /**
   * Resolve the package.json path for a module id.
   *
   * @param {string} [id] The module id to resolve.
   * @returns {string | never} The resolved package.json path.
   */
  pkgJsonPath (id) { return require.resolve((id || '${name}') + '/package.json') },
  /**
   * Resolve the package's version for a module id.
   *
   * @returns {string | never} The resolved package's version.
   */
  version () { return requirePackageJson('${name}', /** @type {import('module').Module} */ (module)).version }
}
`
  await writeFile(filename(name, version, 'index.js'), index)
}

async function assertWorkspaces () {
  await assertFolder()
  await writeFile(filename(null, null, 'package.json'), JSON.stringify({
    name: 'versions',
    version: '1.0.0',
    license: 'BSD-3-Clause',
    private: true,
    workspaces: {
      packages: [...workspaces].sort()
    }
  }, null, 2) + '\n')
}

/**
 * @param {boolean} [retry=true]
 */
function install (retry = true) {
  try {
    exec('yarn --ignore-engines', { cwd: folder() })
  } catch (err) {
    if (!retry) throw err
    install(false) // retry in case of server error from registry
  }
}

/**
 * @param {string} name
 * @param {string|null} [version]
 */
function addFolderToWorkspaces (name, version) {
  if (!excludeList.includes(name)) workspaces.add(basename(name, version))
}

/**
 * @param {string|null} [name]
 * @param {string|null} [version]
 * @returns {string}
 */
function folder (name, version) {
  return join(__dirname, '..', 'versions', basename(name, version))
}

/**
 * @param {string|null} [name]
 * @param {string|null} [version]
 * @returns {string}
 */
function basename (name, version) {
  return name ? (version ? `${name}@${version}` : name) : ''
}

/**
 * @param {string|null} name
 * @param {string|null} version
 * @param {string} file
 * @returns {string}
 */
function filename (name, version, file) {
  return join(folder(name, version), file)
}

/**
 * @overload
 * @param {string} str
 * @returns {string}
 */
/**
 * @overload
 * @param {null} str
 * @returns {undefined}
 */
/**
 * @overload
 * @param {string|null} str
 * @returns {string|undefined}
 */
function sha1 (str) {
  if (!str) return
  const shasum = createHash('sha1')
  shasum.update(str)
  return shasum.digest('hex')
}
