'use strict'

const { lstat, mkdir, readdir, writeFile } = require('fs/promises')
const { arch } = require('os')
const { join } = require('path')
const { createHash } = require('crypto')
const semver = require('semver')
const exec = require('./helpers/exec')
const externals = require('../packages/dd-trace/test/plugins/externals.json')
const { getInstrumentation } = require('../packages/dd-trace/test/setup/helpers/load-inst')
const { getCappedRange } = require('../packages/dd-trace/test/plugins/versions')
const { withBun } = require('./bun')

const requirePackageJsonPath = require.resolve('../packages/dd-trace/src/require-package-json')

// Can remove aerospike after removing support for aerospike < 5.2.0 (for Node.js 22, v5.12.1 is required)
// Can remove couchbase after removing support for couchbase <= 3.2.0
const excludeList = arch() === 'arm64' ? ['aerospike', 'couchbase', 'grpc', 'oracledb'] : []
const workspaces = new Set()
const externalDeps = new Map()

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
  trust()
}

async function assertPrerequisites () {
  const filter = process.env.PLUGINS?.split('|')

  const moduleNames = (await readdir(join(__dirname, '..', 'packages', 'datadog-instrumentations', 'src')))
    .filter(file => file.endsWith('.js'))
    .map(file => file.slice(0, -3))
    .filter(file => !filter || filter.includes(file))

  const internals = moduleNames.reduce((/** @type {object[]} */ internals, moduleName) => {
    internals.push(...getInstrumentation(moduleName))
    return internals
  }, [])

  for (const inst of internals) {
    await assertInstrumentation(inst, false)
  }

  const externalNames = Object.keys(externals).filter(name => moduleNames.includes(name))
  for (const name of externalNames) {
    for (const inst of [].concat(externals[name])) {
      await assertInstrumentation(inst, true)
    }
  }

  await assertWorkspaces()
}

/**
 * @param {object} instrumentation
 * @param {boolean} external
 */
async function assertInstrumentation (instrumentation, external) {
  const versions = process.env.PACKAGE_VERSION_RANGE && !external
    ? [process.env.PACKAGE_VERSION_RANGE]
    : [].concat(instrumentation.versions || [])

  for (const version of versions) {
    if (!version) continue

    if (version !== '*') {
      const result = semver.coerce(version)
      if (!result) throw new Error(`Invalid version: ${version}`)
      await assertModules(instrumentation.name, result.version, external)
    }

    await assertModules(instrumentation.name, version, external)
  }
}

/**
 * @param {string} name
 * @param {string} version
 * @param {boolean} external
 */
async function assertModules (name, version, external) {
  const range = process.env.RANGE
  if (range && !semver.subset(version, range)) return
  await Promise.all([
    assertPackage(name, null, version, external),
    assertPackage(name, version, version, external)
  ])
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
  const dependencies = {
    [name]: getCappedRange(name, dependencyVersionRange)
  }
  const pkg = {
    name: [name, sha1(name).slice(0, 8), sha1(version)].filter(val => val).join('-'),
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

  for (const entry of entries) {
    const folder = join(rootFolder, entry)

    if (!(await lstat(folder)).isDirectory()) continue
    if (entry === 'node_modules') continue
    if (entry.startsWith('@')) {
      await assertPeerDependencies(folder, entry)
      continue
    }

    const externalName = join(parent, entry.split('@')[0])

    if (!externalDeps.has(externalName)) continue

    const versionPkgJsonPath = join(folder, 'package.json')
    const versionPkgJson = require(versionPkgJsonPath)

    for (const { dep, name } of externalDeps.get(externalName)) {
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

          await writeFile(versionPkgJsonPath, JSON.stringify(versionPkgJson, null, 2))

          break
        }
      }
    }
  }
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
      packages: Array.from(workspaces)
    }
  }, null, 2) + '\n')
}

/**
 * @param {boolean} [retry=true]
 */
function install (retry = true) {
  try {
    exec('bun install --linker isolated --ignore-engines', { cwd: folder(), env: withBun() })
  } catch (err) {
    if (!retry) throw err
    install(false) // retry in case of server error from registry
  }
}

function trust () {
  exec('bun pm trust --all || exit 0', { cwd: folder(), env: withBun() })
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
