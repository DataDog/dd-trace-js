'use strict'

const { createHash } = require('crypto')
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('fs')
const { lstat, mkdir, readdir, readFile, writeFile } = require('fs/promises')
const { createRequire } = require('module')
const { arch } = require('os')
const { join, posix } = require('path')

// eslint-disable-next-line n/no-restricted-require
const semver = require('semver')

const externals = require('../packages/dd-trace/test/plugins/externals')
const { getInstrumentation } = require('../packages/dd-trace/test/setup/helpers/load-inst')
const { getCappedRange, resolvePluginVersions } = require('../packages/dd-trace/test/plugins/versions')
const { dependencies: latests, resolutions } = require('../packages/dd-trace/test/plugins/versions/package.json')
const { isRelativeRequire } = require('../packages/datadog-instrumentations/src/helpers/shared-utils')
const exec = require('./helpers/exec')
const mapWithConcurrency = require('./helpers/concurrency')
const requirePackageJsonPath = require.resolve('../packages/dd-trace/src/require-package-json')
const requirePackageJson = require(requirePackageJsonPath)

// Generating the whole versions/ tree is thousands of mkdir/writeFile calls; bound them so we never exhaust file
// descriptors (EMFILE). Dependency installation dominates the wall-clock, so a moderate cap costs nothing.
const FS_CONCURRENCY = 50

// A bare package name, optionally scoped, and nothing else: the only override key Bun applies.
const BARE_PACKAGE_NAME = /^(?:@[^@/]+\/)?[^@/]+$/

// Can remove aerospike after removing support for aerospike < 5.2.0 (for Node.js 22, v5.12.1 is required)
// Can remove couchbase after removing support for couchbase < 3.2.2
const excludeList = arch() === 'arm64' ? ['aerospike', 'couchbase', 'grpc', 'oracledb'] : []
const workspaces = new Set()
const externalDeps = new Map()
const workspaceOverrides = {}
// Names of every package the synthesized workspaces install, both directly (via
// `assertPackage`) and through peer-dep injection (via `assertPeerDependencies`).
// Bun runs lifecycle scripts only for packages listed in the workspace root's
// `trustedDependencies`; native plugins (`aerospike`, `@confluentinc/kafka-javascript`,
// `pg-native`, ...) need their `install`/`postinstall` to compile, otherwise
// `node-gyp`'s `bindings` package fails to find the `.node` file at test time.
// Bun's `trustedDependencies` does not transitively allow nested packages; externals.js
// declares any transitive native builders a sandbox needs.
const trustedDependencies = new Set()

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
  invalidateCacheOnNodeAbiChange()
  const deferredPackageStages = await assertPrerequisites()
  install()
  await installPackageStages(deferredPackageStages)
  const changed = await assertPeerDependencies(join(__dirname, '..', 'versions'))
  // The peer-dependency install only does something when patching actually changed a manifest. Targeted
  // installs for plugins without external peer dependencies (the common CI matrix case) skip it entirely.
  if (changed) install()
}

/**
 * @param {Array<Array<{ name: string, version: string|null, range: string }>>} packageStages
 * @param {number} [index]
 * @returns {Promise<void>}
 */
async function installPackageStages (packageStages, index = 0) {
  if (index >= packageStages.length) return

  await mapWithConcurrency(packageStages[index], FS_CONCURRENCY, assertPackage)
  await assertWorkspaces()
  install()
  return installPackageStages(packageStages, index + 1)
}

/**
 * A native binding compiled during the first `npm run services` can be reused
 * verbatim on the next invocation under a different Node major and fail at
 * load time. Wipe the shared install when the Node ABI changes so the next
 * `bun install --trust` reruns lifecycle scripts against the live runtime.
 */
function invalidateCacheOnNodeAbiChange () {
  const versionsDir = join(__dirname, '..', 'versions')
  const nodeAbiFile = join(versionsDir, '.node-abi')
  const currentAbi = process.versions.modules
  const recordedAbi = existsSync(nodeAbiFile) ? readFileSync(nodeAbiFile, 'utf8').trim() : ''
  if (recordedAbi && recordedAbi !== currentAbi && existsSync(join(versionsDir, 'node_modules'))) {
    rmSync(join(versionsDir, 'node_modules'), { recursive: true, force: true })
    rmSync(join(versionsDir, 'bun.lock'), { force: true })
  }
  mkdirSync(versionsDir, { recursive: true })
  writeFileSync(nodeAbiFile, currentAbi)
}

async function assertPrerequisites () {
  const filter = process.env.PLUGINS?.split('|')

  const instrumentationFiles = await readdir(join(__dirname, '..', 'packages', 'datadog-instrumentations', 'src'))
  const moduleNames = instrumentationFiles.filter(file => file.endsWith('.js'))
    .map(file => file.slice(0, -3))
    .filter(file => !filter || filter.includes(file))

  const packages = collectPackages(moduleNames)

  applyExternalConfiguration(moduleNames, packages)
  const [initialPackages = [], ...deferredPackageStages] = buildInstallStages(packages)
  await mapWithConcurrency(initialPackages, FS_CONCURRENCY, assertPackage)

  await assertWorkspaces()
  return deferredPackageStages
}

/**
 * @param {Array<{ name: string, version: string|null, range: string }>} packages
 * @returns {Array<Array<{ name: string, version: string|null, range: string }>>}
 */
function buildInstallStages (packages) {
  const packageStages = []
  const rangeStages = []
  const orderedPackages = packages.map(entry => {
    const range = getCappedRange(entry.name, entry.range)
    return { entry, range, maximum: getRangeMaximum(range) }
  })
  orderedPackages.sort((left, right) => semver.rcompare(left.maximum, right.maximum))

  // Bun collapses overlapping workspace ranges to one version. Lock higher ranges before adding intersecting floors.
  for (const { entry, range } of orderedPackages) {
    let stageIndex = 0

    for (let index = 0; index < rangeStages.length; index++) {
      const stagedRanges = rangeStages[index].get(entry.name)
      if (!stagedRanges) continue
      for (const stagedRange of stagedRanges) {
        if (semver.intersects(range, stagedRange)) {
          stageIndex = index + 1
          break
        }
      }
    }

    if (stageIndex === packageStages.length) {
      packageStages.push([])
      rangeStages.push(new Map())
    }
    packageStages[stageIndex].push(entry)
    const stagedRanges = rangeStages[stageIndex].get(entry.name)
    if (stagedRanges) {
      stagedRanges.push(range)
    } else {
      rangeStages[stageIndex].set(entry.name, [range])
    }
  }

  return packageStages
}

/**
 * @param {string} range
 * @returns {import('semver').SemVer}
 */
function getRangeMaximum (range) {
  let rangeMaximum
  for (const comparatorSet of new semver.Range(range).set) {
    let setMaximum
    for (const comparator of comparatorSet) {
      if (
        comparator.value &&
        (comparator.operator === '' || comparator.operator === '<' || comparator.operator === '<=') &&
        (!setMaximum || semver.lt(comparator.semver, setMaximum))
      ) {
        setMaximum = comparator.semver
      }
    }
    if (!rangeMaximum || semver.gt(setMaximum, rangeMaximum)) rangeMaximum = setMaximum
  }
  return rangeMaximum
}

/**
 * @param {string[]} moduleNames
 * @param {Array<{ name: string }>} packages
 */
function applyExternalConfiguration (moduleNames, packages) {
  const activeNames = new Set(moduleNames)
  for (const { name } of packages) activeNames.add(name)

  for (const name of activeNames) {
    const configurations = externals[name]
    if (!configurations) continue

    for (const external of configurations) {
      if (external.dep) trustedDependencies.add(external.name)
      if (external.trustedDependencies) {
        for (const trustedDependency of external.trustedDependencies) {
          trustedDependencies.add(trustedDependency)
        }
      }
      if (!external.overrides) continue

      for (const [dependency, version] of Object.entries(external.overrides)) {
        // Bun only honours a bare package name. A Yarn-style selective path (`parent@1.0.0/child`) or an
        // npm-style nested object is accepted into the manifest and then silently ignored, so the range
        // reads as enforced while resolution stays untouched.
        if (!BARE_PACKAGE_NAME.test(dependency) || typeof version !== 'string') {
          throw new Error(
            `Override '${dependency}' cannot be expressed as a Bun override. Bun only supports a bare package ` +
            'name mapped to a version range, and applies it to every workspace.'
          )
        }
        const configuredVersion = workspaceOverrides[dependency]
        if (configuredVersion !== undefined && configuredVersion !== version) {
          throw new Error(`Conflicting overrides for '${dependency}': '${configuredVersion}' and '${version}'`)
        }
        workspaceOverrides[dependency] = version
      }
    }
  }
}

/**
 * Build the ordered, de-duplicated set of workspace folders to generate. A version that is referenced under several
 * notations (or by both an internal and an external entry) is generated once; internal entries are processed first so
 * their declaration wins for any shared folder.
 *
 * @param {string[]} moduleNames
 * @returns {Array<{ name: string, version: string|null, range: string }>}
 */
function collectPackages (moduleNames) {
  const seen = new Set()
  /** @type {Array<{ name: string, version: string|null, range: string }>} */
  const packages = []

  /**
   * @param {string} name
   * @param {string|null} version
   * @param {string} range
   */
  const addFolder = (name, version, range) => {
    // File-path requires are resolved from disk; their non-path counterparts already cover them.
    if (isRelativeRequire(name)) return
    const key = basename(name, version)
    if (seen.has(key)) return
    seen.add(key)
    packages.push({ name, version, range })
  }

  /**
   * @param {Array<{ name: string, versions?: string[], node?: string }>} instrumentations
   * @param {boolean} external
   * @param {string} [pluginName] The plugin key an external entry belongs to. Same-name externals (e.g. the aerospike
   *   entry mirroring the addHook versions) honour `PACKAGE_VERSION_RANGE` so per-major CI matrices do not force every
   *   major to install on every job.
   */
  const addInstrumentations = (instrumentations, external, pluginName) => {
    const declarationsByName = new Map()

    for (const instrumentation of instrumentations) {
      const declarations = declarationsByName.get(instrumentation.name)
      if (declarations) {
        declarations.push(instrumentation)
      } else {
        declarationsByName.set(instrumentation.name, [instrumentation])
      }
    }

    for (const [name, declarations] of declarationsByName) {
      const { versionList, unversioned } = resolvePluginVersions({
        name,
        declarations,
        honourEnvRange: !external || name === pluginName,
      })

      // The unversioned `versions/<name>` folder is the default `require('versions/<name>')` target used by service
      // setup and several plugin specs.
      if (unversioned) addFolder(name, null, unversioned)

      for (const { versionKey } of versionList) {
        addFolder(name, versionKey, versionKey)
      }
    }
  }

  for (const moduleName of moduleNames) {
    addInstrumentations(getInstrumentation(moduleName), false)
  }

  for (const name of Object.keys(externals)) {
    if (!moduleNames.includes(name)) continue
    addInstrumentations(externals[name], true, name)
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
 * @param {{ name: string, version: string|null, range: string }} entry
 */
async function assertPackage ({ name, version, range: dependencyVersionRange }) {
  trustedDependencies.add(name)
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
      folders.push(...await collectPeerDependencyFolders(current, posix.join(parent, entry)))
      continue
    }

    const externalName = posix.join(parent, entry.split('@', 1)[0])
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

  for (const { dep, name, node, forced, version } of externalDeps.get(externalName)) {
    if (node && !semver.satisfies(process.versions.node, node)) {
      continue
    }
    if (!pkgJson) {
      const requireFromWorkspace = createRequire(join(folder, 'package.json'))
      const nodeModulesPaths = requireFromWorkspace.resolve.paths(externalName)
      pkgJson = requirePackageJson(externalName, { paths: nodeModulesPaths })
    }

    for (const section of ['devDependencies', 'peerDependencies', 'optionalDependencies']) {
      if (pkgJson[section]?.[name]) {
        if (dep === externalName) {
          versionPkgJson.dependencies[name] = pkgJson.version
        } else if (version) {
          versionPkgJson.dependencies[name] = capKnownRange(name, version)
        } else {
          const declared = pkgJson[section][name]
          const range = declared.startsWith('workspace:')
            // A `workspace:` protocol leaked into the published manifest (some monorepo packages publish it raw); it
            // cannot resolve outside the source repo, so fall back to the pinned compatible version.
            ? (latests[name] ?? '*')
            : declared.includes('||')
              // Use the first version in the list (as npm does by default)
              ? declared.split('||', 1)[0].trim()
              // Only one version available so use that.
              : declared
          versionPkgJson.dependencies[name] = capKnownRange(name, range)
        }
        break
      }
    }

    if (!versionPkgJson.dependencies[name] && forced) {
      // An explicit `version` in externals.js wins, then the range the installed package declares for itself, and
      // only then the newest published version. The declared range matters because a forced transitive has to stay
      // in the same generation as the sandbox consuming it: resolving `*` against the registry grafts the newest
      // major onto an old client (a `@smithy/*` v4 handler onto the v2-era `@aws-sdk/client-bedrock-runtime@3.422.0`),
      // and that handler's own transitives then resolve independently of the rest of the sandbox. Which majors
      // collide changes every time the dependency publishes, so the sandbox breaks on an unrelated day.
      const range = version ?? pkgJson.dependencies?.[name] ?? latests[name]
      versionPkgJson.dependencies[name] = capKnownRange(name, range)
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
  const workspaceName = parent ? posix.join(parent, entry) : entry

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
  // `require.resolve('<name>/package.json')` works for the common case but
  // throws `ERR_PACKAGE_PATH_NOT_EXPORTED` for packages that ship an `exports`
  // map without a `./package.json` entry (moleculer, react, ...). Walking
  // `module.paths` mirrors `requirePackageJson` and stays exports-blind.
  const index = `'use strict'

const path = require('path')
const fs = require('fs')

const requirePackageJson = require('${requirePackageJsonPath}')

/**
 * @param {string} id
 * @returns {string}
 */
function findPkgJsonPath (id) {
  for (const modulePath of module.paths) {
    const candidate = path.join(modulePath, id, 'package.json')
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error('could not find ' + id + '/package.json')
}

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
  pkgJsonPath (id) { return findPkgJsonPath(id || '${name}') },
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
    resolutions,
    workspaces: {
      packages: [...workspaces].sort(),
    },
    overrides: workspaceOverrides,
    trustedDependencies: [...trustedDependencies].sort(),
  }, null, 2) + '\n')
}

function install () {
  try {
    exec('bun install --trust', { cwd: folder() })
  } catch (error) {
    // A failure is most often an unresolvable version: a declared range spans a major version that was never
    // published. Point at the fix instead of leaving a bare bun error.
    throw new Error(
      'bun failed to install the generated versions/ workspaces. If a plugin declares a version range that spans a ' +
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
 * @param {string} range
 * @returns {string}
 */
function capKnownRange (name, range) {
  return latests[name] === undefined ? range : getCappedRange(name, range)
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
