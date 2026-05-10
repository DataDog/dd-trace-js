'use strict'

const { execFileSync } = require('child_process')
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
const retry = require('./helpers/retry')
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
// Per-process cache of `bun pm view` lookups so a matrix run doesn't hit the registry twice
// for the same `<name>@<range>` pair across the script's two install passes.
const resolvedRangeCache = new Map()
// Names of every package the synthesized workspaces install, both directly (via
// `assertPackage`) and through peer-dep injection (via `assertPeerDependencies`).
// Bun runs lifecycle scripts only for packages listed in the workspace root's
// `trustedDependencies`; native plugins (`aerospike`, `@confluentinc/kafka-javascript`,
// `pg-native`, ...) need their `install`/`postinstall` to compile, otherwise
// `node-gyp`'s `bindings` package fails to find the `.node` file at test time.
// Bun's `trustedDependencies` does not transitively allow nested packages, so
// transitively-required native modules (e.g. `pg-native` → `libpq`) need their
// own entry here.
const trustedDependencies = new Set([
  // `pg-native` ships JS bindings only; the actual native build sits in `libpq`,
  // whose `install` script invokes `node-gyp` to produce `addon.node`.
  'libpq',
])

for (const external of Object.keys(externals)) {
  for (const thing of externals[external]) {
    trustedDependencies.add(thing.name)
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
      if (unversioned) addFolder(name, null, unversioned, external)

      for (const { versionKey } of versionList) {
        addFolder(name, versionKey, versionKey, external)
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
 * @param {string} name
 * @param {string|null} version
 * @param {string} dependencyVersionRange
 */
async function assertPackage (name, version, dependencyVersionRange, external) {
  trustedDependencies.add(name)
  const dependencies = {
    [name]: resolveLatestSatisfying(name, getCappedRange(name, dependencyVersionRange)),
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

  for (const { dep, name, node, forced, version } of externalDeps.get(externalName)) {
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
          const declared = pkgJson[section][name]
          const range = declared.startsWith('workspace:')
            // A `workspace:` protocol leaked into the published manifest (some monorepo packages publish it raw); it
            // cannot resolve outside the source repo, so fall back to the pinned compatible version.
            ? (latests[name] ?? '*')
            : declared.includes('||')
              // Use the first version in the list (as npm does by default)
              ? declared.split('||')[0].trim()
              // Only one version available so use that.
              : declared
          versionPkgJson.dependencies[name] = resolveLatestSatisfying(name, range)
        }
        break
      }
    }

    if (!versionPkgJson.dependencies[name] && forced) {
      versionPkgJson.dependencies[name] = version || latests[name]
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
  await Promise.all([
    writeFile(filename(null, null, 'package.json'), JSON.stringify({
      name: 'versions',
      version: '1.0.0',
      license: 'BSD-3-Clause',
      private: true,
      workspaces: {
        packages: [...workspaces].sort(),
      },
      // `@langchain/openai` is a transitive of `langchain` that the langchain
      // plugin specs require directly from each `langchain@<version>` sandbox.
      // The isolated linker does not hoist transitives to the workspace root,
      // so pin it here. 0.0.34 is the version the recorded cassettes match
      // (`OpenAI/JS 4.x` request shape); newer pins need their own cassettes.
      dependencies: {
        '@langchain/openai': '0.0.34',
      },
      trustedDependencies: [...trustedDependencies].sort(),
    }, null, 2) + '\n'),
    // Per-sandbox node_modules via bun's isolated linker. Several plugin specs
    // hard-code paths into `versions/<plugin>@<ver>/node_modules/<plugin>/<internal>`
    // (kafkajs reaches into `src/broker`, next reads `package.json`, rhea pulls
    // `lib/session.js`); under isolated bun creates a symlink at that path that
    // resolves to the central store, so the lookups work. Cross-workspace
    // dependencies (moleculer's runtime `require('bluebird')` fallback, etc.) are
    // wired through `externals.js` `dep: true, forced: true` so they land as a
    // direct dep of the consuming sandbox rather than as a sibling workspace.
    writeFile(filename(null, null, 'bunfig.toml'), `[install]
linker = "isolated"
saveTextLockfile = true
`),
  ])
}

/**
 * Install the generated versions/ workspaces.
 *
 * Some workspaces download large prebuilt binaries at postinstall time (e.g. Electron pulls one archive per major
 * from GitHub's release CDN), which intermittently fail with 5xx gateway errors. Retry with backoff so a brief CDN
 * outage doesn't fail the whole job.
 */
function install () {
  try {
    retry(() => exec('bun install --trust', { cwd: folder() }), {
      onRetry: (error, attempt, delayMs) => process.stderr.write(
        `bun install attempt ${attempt} failed, retrying in ${delayMs / 1000}s: ${error.message}\n`
      ),
    })
  } catch (error) {
    // A failure that outlasts the retries is most often an unresolvable version: a declared range spans a major
    // version that was never published. Point at the fix instead of leaving a bare bun error.
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
 * Resolve a semver range to the highest published version satisfying it.
 *
 * Yarn 1 picked the highest matching version per install; bun picks the lowest.
 * Without pre-resolution the per-major matrix collapses — `<pkg>@<range>` and
 * `<pkg>@<coerced>` would land on the same version under bun.
 *
 * @param {string} name
 * @param {string} range
 * @returns {string}
 */
function resolveLatestSatisfying (name, range) {
  if (semver.valid(range)) return range
  const cacheKey = `${name}@${range}`
  const cached = resolvedRangeCache.get(cacheKey)
  if (cached) return cached
  let parsed
  try {
    const stdout = execFileSync('bun', ['pm', 'view', cacheKey, 'version', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    parsed = JSON.parse(stdout)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`bun pm view failed for ${cacheKey}: ${error.message}; deferring to install-time resolution`)
    return range
  }
  if (typeof parsed !== 'string') {
    // eslint-disable-next-line no-console
    console.warn(`bun pm view returned no version for ${cacheKey}: ${JSON.stringify(parsed)}; ` +
      'deferring to install-time resolution')
    return range
  }
  resolvedRangeCache.set(cacheKey, parsed)
  return parsed
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
