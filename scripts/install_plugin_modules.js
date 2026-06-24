'use strict'

const { createHash } = require('crypto')
const { lstat, mkdir, readdir, readFile, writeFile } = require('fs/promises')
const { createRequire } = require('module')
const { arch } = require('os')
const { join } = require('path')

// eslint-disable-next-line n/no-restricted-require
const semver = require('semver')

const externals = require('../packages/dd-trace/test/plugins/externals')
const { getInstrumentation } = require('../packages/dd-trace/test/setup/helpers/load-inst')
const { getCappedRange, resolvePluginVersions } = require('../packages/dd-trace/test/plugins/versions')
const latests = require('../packages/dd-trace/test/plugins/versions/package.json').dependencies
const { isRelativeRequire } = require('../packages/datadog-instrumentations/src/helpers/shared-utils')
const exec = require('./helpers/exec')
const mapWithConcurrency = require('./helpers/concurrency')
const requirePackageJsonPath = require.resolve('../packages/dd-trace/src/require-package-json')
const requirePackageJson = require(requirePackageJsonPath)

// Generating the whole versions/ tree is thousands of mkdir/writeFile calls; bound them so we never exhaust file
// descriptors (EMFILE). yarn install itself dominates the wall-clock, so a moderate cap costs nothing.
const FS_CONCURRENCY = 50

// Can remove aerospike after removing support for aerospike < 5.2.0 (for Node.js 22, v5.12.1 is required)
// Can remove couchbase after removing support for couchbase < 3.2.2
const excludeList = arch() === 'arm64' ? ['aerospike', 'couchbase', 'grpc', 'oracledb'] : []
const workspaces = new Set()
const externalDeps = new Map()

for (const external of Object.keys(externals)) {
  for (const thing of externals[external]) {
    if (thing.dep) {
      const depsArr = externalDeps.get(external)
      if (depsArr) {
        depsArr.push(thing)
      } else {
        externalDeps.set(external, [thing])
      }
    }
  }
}

run()

async function run () {
  await assertPrerequisites()
  install()
  const changed = await assertPeerDependencies(join(__dirname, '..', 'versions'))
  // The second install only does something when peer-dependency patching actually changed a manifest. Targeted
  // installs for plugins without external peer dependencies (the common CI matrix case) skip it entirely.
  if (changed) install()
}

async function assertPrerequisites () {
  const filter = process.env.PLUGINS?.split('|')

  const instrumentationFiles = await readdir(join(__dirname, '..', 'packages', 'datadog-instrumentations', 'src'))
  const moduleNames = instrumentationFiles.filter(file => file.endsWith('.js'))
    .map(file => file.slice(0, -3))
    .filter(file => !filter || filter.includes(file))

  const packages = collectPackages(moduleNames)

  await mapWithConcurrency(packages, FS_CONCURRENCY, ({ name, version, range, external }) =>
    assertPackage(name, version, range, external))

  await assertWorkspaces()
}

/**
 * Build the ordered, de-duplicated set of workspace folders to generate. A version that is referenced under several
 * notations (or by both an internal and an external entry) is generated once; internal entries are processed first so
 * the nohoisted (isolated) variant wins for any shared folder.
 *
 * @param {string[]} moduleNames
 * @returns {Array<{ name: string, version: string|null, range: string, external: boolean }>}
 */
function collectPackages (moduleNames) {
  const seen = new Set()
  /** @type {Array<{ name: string, version: string|null, range: string, external: boolean }>} */
  const packages = []

  const addFolder = (name, version, range, external) => {
    // File-path requires are resolved from disk; their non-path counterparts already cover them.
    if (isRelativeRequire(name)) return
    const key = basename(name, version)
    if (seen.has(key)) return
    seen.add(key)
    packages.push({ name, version, range, external })
  }

  /**
   * @param {{ name: string, versions?: string[] }} instrumentation
   * @param {boolean} external
   * @param {string} [pluginName] The plugin key an external entry belongs to. Same-name externals (e.g. the aerospike
   *   entry mirroring the addHook versions) honour `PACKAGE_VERSION_RANGE` so per-major CI matrices do not force every
   *   major to install on every job.
   */
  const addInstrumentation = (instrumentation, external, pluginName) => {
    const { versionList, unversioned } = resolvePluginVersions({
      name: instrumentation.name,
      declaredVersions: instrumentation.versions || [],
      honourEnvRange: !external || instrumentation.name === pluginName,
    })

    // The unversioned `versions/<name>` folder is the default `require('versions/<name>')` target used by service
    // setup and several plugin specs.
    if (unversioned) addFolder(instrumentation.name, null, unversioned, external)

    for (const { versionKey } of versionList) {
      addFolder(instrumentation.name, versionKey, versionKey, external)
    }
  }

  for (const moduleName of moduleNames) {
    for (const instrumentation of getInstrumentation(moduleName)) {
      addInstrumentation(instrumentation, false)
    }
  }

  for (const name of Object.keys(externals)) {
    if (!moduleNames.includes(name)) continue
    for (const instrumentation of externals[name]) {
      addInstrumentation(instrumentation, true, name)
    }
  }

  return packages
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
    [name]: getCappedRange(name, dependencyVersionRange),
  }
  const pkg = {
    name: [name, sha1(name).slice(0, 8), sha1(version)].filter(Boolean).join('-'),
    version: '1.0.0',
    license: 'BSD-3-Clause',
    private: true,
    dependencies,
  }

  if (name === 'aerospike') {
    pkg.installConfig = {
      hoistingLimits: 'workspaces',
    }
  } else if (!external) {
    pkg.workspaces = {
      nohoist: ['**/**'],
    }
  }

  addFolderToWorkspaces(name, version)
  await assertFolder(name, version)
  await Promise.all([
    writeFile(filename(name, version, 'package.json'), JSON.stringify(pkg, null, 2) + '\n'),
    assertIndex(name, version),
  ])
}

/**
 * Patch generated workspace manifests with the peer/dev dependency versions resolved from the installed packages, so a
 * second install pulls compatible peers.
 *
 * @param {string} rootFolder
 * @returns {Promise<boolean>} Whether any manifest changed (and therefore a second install is required).
 */
async function assertPeerDependencies (rootFolder) {
  const folders = await collectPeerDependencyFolders(rootFolder)
  const changes = await mapWithConcurrency(folders, FS_CONCURRENCY, patchPeerDependencies)
  return changes.some(Boolean)
}

/**
 * Walk the generated tree and return the leaf workspace folders that have external peer dependencies to patch.
 *
 * @param {string} rootFolder
 * @param {string} [parent]
 * @returns {Promise<Array<{ folder: string, externalName: string }>>}
 */
async function collectPeerDependencyFolders (rootFolder, parent = '') {
  const entries = await readdir(rootFolder)
  const folders = []

  for (const entry of entries) {
    const current = join(rootFolder, entry)

    // eslint-disable-next-line no-await-in-loop
    const folderStat = await lstat(current)
    if (!folderStat.isDirectory()) continue
    if (entry === 'node_modules') continue
    if (!isGeneratedWorkspace(entry, parent)) continue
    if (entry.startsWith('@')) {
      // eslint-disable-next-line no-await-in-loop
      folders.push(...await collectPeerDependencyFolders(current, parent ? join(parent, entry) : entry))
      continue
    }

    const externalName = join(parent, entry.split('@')[0])
    if (externalDeps.has(externalName)) folders.push({ folder: current, externalName })
  }

  return folders
}

/**
 * @param {{ folder: string, externalName: string }} entry
 * @returns {Promise<boolean>} Whether the manifest changed on disk.
 */
async function patchPeerDependencies ({ folder, externalName }) {
  const versionPkgJsonPath = join(folder, 'package.json')
  const before = await readFile(versionPkgJsonPath, 'utf8')
  const versionPkgJson = JSON.parse(before)

  let pkgJson

  for (const { dep, name, node, forced } of externalDeps.get(externalName)) {
    if (node && !semver.satisfies(process.versions.node, node)) {
      continue
    }
    if (!pkgJson) {
      const requireFromWorkspace = createRequire(join(folder, 'package.json'))
      const nodeModulesPaths = requireFromWorkspace.resolve.paths(externalName)
      pkgJson = requirePackageJson(externalName, { paths: nodeModulesPaths })
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
        break
      }
    }

    if (!versionPkgJson.dependencies[name] && forced) {
      versionPkgJson.dependencies[name] = latests[name]
    }
  }

  const after = JSON.stringify(versionPkgJson, null, 2) + '\n'
  if (after === before) return false

  await writeFile(versionPkgJsonPath, after)
  return true
}

/**
 * Only inspect workspaces generated for the current install run.
 * This avoids stale folders in `versions/` from breaking targeted installs.
 *
 * @param {string} entry
 * @param {string} [parent]
 * @returns {boolean}
 */
function isGeneratedWorkspace (entry, parent = '') {
  const workspaceName = parent ? join(parent, entry) : entry

  if (entry.startsWith('@')) {
    for (const workspace of workspaces) {
      if (workspace.startsWith(`${workspaceName}/`)) {
        return true
      }
    }
    return false
  }

  return workspaces.has(workspaceName)
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
      packages: [...workspaces].sort(),
    },
  }, null, 2) + '\n')
}

/**
 * @param {boolean} [retry]
 */
function install (retry = true) {
  try {
    exec('yarn --ignore-engines', { cwd: folder() })
  } catch (error) {
    if (retry) {
      install(false) // retry in case of server error from registry
      return
    }
    // A non-transient failure is most often an unresolvable version: a declared range spans a major version that was
    // never published. Point at the fix instead of leaving a bare yarn error.
    throw new Error(
      'yarn failed to install the generated versions/ workspaces. If a plugin declares a version range that spans a ' +
      'major version that was never published (non-consecutive majors), add that package to ' +
      '`nonConsecutiveMajorPackages` in packages/dd-trace/test/plugins/versions/index.js (or split the range) so its ' +
      'in-between majors are not installed.\n' +
      `Original error: ${error.message}`,
      { cause: error }
    )
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
