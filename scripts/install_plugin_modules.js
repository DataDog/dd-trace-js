'use strict'

const { createHash } = require('crypto')
const { mkdir, readdir, writeFile } = require('fs/promises')
const { arch } = require('os')
const { join } = require('path')

// eslint-disable-next-line n/no-restricted-require
const semver = require('semver')

const externals = require('../packages/dd-trace/test/plugins/externals.json')
const { getInstrumentation } = require('../packages/dd-trace/test/setup/helpers/load-inst')
const { getCappedRange } = require('../packages/dd-trace/test/plugins/versions')
const { BUN, withBun } = require('../integration-tests/helpers/bun')
const exec = require('./helpers/exec')

const requirePackageJsonPath = require.resolve('../packages/dd-trace/src/require-package-json')

// Can remove aerospike after removing support for aerospike < 5.2.0 (for Node.js 22, v5.12.1 is required)
// Can remove couchbase after removing support for couchbase <= 3.2.0
const excludeList = arch() === 'arm64' ? ['aerospike', 'couchbase', 'grpc', 'oracledb'] : []
// List of trusted transitive dependencies to execute scripts for.
const trustedList = ['libpq']
const workspaces = new Set()
const externalDeps = Object.create(null)
const plugins = Object.create(null)

run()

async function run () {
  await assertPrerequisites()
  install(process.env.BUN_FORCE_INSTALL === 'true')
  await assertPeerDependencies()
}

async function assertPrerequisites () {
  const filter = process.env.PLUGINS?.split('|')

  const instrumentationFiles = await readdir(join(__dirname, '..', 'packages', 'datadog-instrumentations', 'src'))
  const moduleNames = instrumentationFiles.filter(file => file.endsWith('.js'))
    .map(file => file.slice(0, -3))
    .filter(file => !filter || filter.includes(file))

  const internals = moduleNames.reduce((/** @type {object[]} */ internals, moduleName) => {
    const instrumentations = getInstrumentation(moduleName)
    internals.push(...instrumentations)
    for (const { name } of instrumentations) {
      plugins[name] = moduleName
    }
    return internals
  }, [])

  for (const inst of internals) {
    // eslint-disable-next-line no-await-in-loop
    await assertInstrumentation(inst, false)
  }

  const externalNames = Object.keys(externals).filter(name => moduleNames.includes(name))

  for (const name of externalNames) {
    for (const inst of [externals[name]].flat()) {
      if (inst.dep) {
        externalDeps[name] ??= []
        externalDeps[name].push(inst)
      }
      // eslint-disable-next-line no-await-in-loop
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
    : (instrumentation.versions || [])

  for (const version of versions) {
    if (!version) continue

    if (version !== '*') {
      const result = semver.coerce(version)
      if (!result) throw new Error(`Invalid version: ${version}`)
      // eslint-disable-next-line no-await-in-loop
      await assertModules(instrumentation.name, result.version)
    }

    // eslint-disable-next-line no-await-in-loop
    await assertModules(instrumentation.name, version)
  }
}

/**
 * @param {string} name
 * @param {string} version
 */
async function assertModules (name, version) {
  const range = process.env.RANGE
  if (range && !semver.subset(version, range)) return
  await Promise.all([
    assertPackage(name, null, version),
    assertPackage(name, version, version),
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
 */
async function assertPackage (name, version, dependencyVersionRange, external) {
  const dependencies = {
    [name]: getCappedRange(name, dependencyVersionRange),
  }
  const pkg = {
    name: [name, sha1(name).slice(0, 8), sha1(version)].filter(Boolean).join('-'),
    version: '1.0.0',
    license: 'BSD-3-Clause',
    private: true,
    dependencies,
    trustedDependencies: [name, ...trustedList],
  }

  addFolderToWorkspaces(name, version)
  await assertFolder(name, version)
  await Promise.all([
    writeFile(filename(name, version, 'package.json'), JSON.stringify(pkg, null, 2) + '\n'),
    assertIndex(name, version),
  ])
}

async function assertPeerDependencies () {
  let hasPeers = false

  for (const workspace of workspaces) {
    const folder = join(__dirname, '..', 'versions', workspace)
    const externalName = workspace.split('@').slice(0, -1).join('@')
    const pluginName = plugins[externalName]

    if (!externalDeps[pluginName]) continue

    const versionPkgJsonPath = join(folder, 'package.json')
    const versionPkgJson = require(versionPkgJsonPath)

    for (const { dep, name } of externalDeps[pluginName]) {
      const pkgJsonPath = join(folder, 'node_modules', externalName, 'package.json')
      const pkgJson = require(pkgJsonPath)

      // Add missing dependency to the module. While having to do this
      // technically means the module itself is broken, a user could add the
      // dependency manually as well, so we need to do the same thing in order
      // to test that scenario.
      if (typeof dep === 'string' && semver.validRange(dep)) {
        versionPkgJson.dependencies[name] = dep

        hasPeers = true

        // eslint-disable-next-line no-await-in-loop
        await writeFile(versionPkgJsonPath, JSON.stringify(versionPkgJson, null, 2))

        continue
      }

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

          hasPeers = true

          // eslint-disable-next-line no-await-in-loop
          await writeFile(versionPkgJsonPath, JSON.stringify(versionPkgJson, null, 2))

          break
        }
      }
    }
  }

  if (hasPeers) {
    install()
  }
}

/**
 * @param {string} name
 * @param {string|null} version
 */
async function assertIndex (name, version) {
  const index = `'use strict'

const { realpathSync } = require('fs')
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
   * Load the module following pnpm-style symlinks.
   *
   * @param {...string} [ids] The names/ids of the transitive module to get.
   * @returns {import('${name}') | never} The module.
   */
  follow (...ids) {
    let prefix = __dirname + '/node_modules'

    for (const [i, id] of ['${name}'].concat(ids).entries()) {
      if (i === ids.length) return require(prefix + '/' + (id || '${name}'))
      prefix = realpathSync(prefix + '/' + id)
        .split('/node_modules')
        .slice(0, -1)
        .join('/node_modules') + '/node_modules'
    }
  },
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
      packages: [...workspaces].sort(),
    },
  }, null, 2) + '\n')
}

/**
 * @param {boolean} [force=false]
 * @param {boolean} [retry=true]
 */
function install (force = false, retry = true) {
  const flags = ['--linker=isolated']

  // Bun doesn't have a `rebuild` command, so the only way to rebuild native
  // extensions is to force a reinstall.
  if (force) {
    flags.push('--force')
  }

  try {
    exec(`${BUN} install ${flags.join(' ')}`, { cwd: folder(), env: withBun() })
  } catch (err) {
    if (!retry) throw err
    install(force, false) // retry in case of server error from registry
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
