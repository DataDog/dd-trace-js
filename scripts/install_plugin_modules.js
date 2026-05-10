'use strict'

const { execFileSync } = require('child_process')
const { createHash } = require('crypto')
const { lstat, mkdir, readdir, writeFile } = require('fs/promises')
const { arch } = require('os')
const { join } = require('path')

// eslint-disable-next-line n/no-restricted-require
const semver = require('semver')

const externals = require('../packages/dd-trace/test/plugins/externals')
const { getInstrumentation } = require('../packages/dd-trace/test/setup/helpers/load-inst')
const { getCappedRange } = require('../packages/dd-trace/test/plugins/versions')
const latests = require('../packages/dd-trace/test/plugins/versions/package.json').dependencies
const { isRelativeRequire } = require('../packages/datadog-instrumentations/src/helpers/shared-utils')
const exec = require('./helpers/exec')
const requirePackageJsonPath = require.resolve('../packages/dd-trace/src/require-package-json')

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
  await assertPeerDependencies(join(__dirname, '..', 'versions'))
  install()
}

async function assertPrerequisites () {
  const filter = process.env.PLUGINS?.split('|')

  const instrumentationFiles = await readdir(join(__dirname, '..', 'packages', 'datadog-instrumentations', 'src'))
  const moduleNames = instrumentationFiles.filter(file => file.endsWith('.js'))
    .map(file => file.slice(0, -3))
    .filter(file => !filter || filter.includes(file))

  const internals = moduleNames.reduce((/** @type {object[]} */ internals, moduleName) => {
    internals.push(...getInstrumentation(moduleName))
    return internals
  }, [])

  for (const inst of internals) {
    // eslint-disable-next-line no-await-in-loop
    await assertInstrumentation(inst, false)
  }

  const externalNames = Object.keys(externals).filter(name => moduleNames.includes(name))

  for (const name of externalNames) {
    for (const inst of externals[name]) {
      // eslint-disable-next-line no-await-in-loop
      await assertInstrumentation(inst, true, name)
    }
  }

  await assertWorkspaces()
}

/**
 * @param {object} instrumentation
 * @param {boolean} external
 * @param {string} [pluginName] The plugin key the external entry belongs to. Same-name externals (e.g. the aerospike
 *   externals entry that mirrors the addHook versions) honour `PACKAGE_VERSION_RANGE` so per-major CI matrices do not
 *   force every major to install on every job.
 */
async function assertInstrumentation (instrumentation, external, pluginName) {
  const honourEnvRange = !external || instrumentation.name === pluginName
  const versions = process.env.PACKAGE_VERSION_RANGE && honourEnvRange
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
async function assertPackage (name, version, dependencyVersionRange) {
  // Early return to prevent filePaths from being installed, their non path counterparts should suffice
  if (isRelativeRequire(name)) return
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
 * @param {object} rootFolder
 * @param {string} parent
 */
async function assertPeerDependencies (rootFolder, parent = '') {
  const entries = await readdir(rootFolder)

  for (const entry of entries) {
    const folder = join(rootFolder, entry)

    // eslint-disable-next-line no-await-in-loop
    const folderStat = await lstat(folder)
    if (!folderStat.isDirectory()) continue
    if (entry === 'node_modules') continue
    if (!isGeneratedWorkspace(entry, parent)) continue
    if (entry.startsWith('@')) {
      // eslint-disable-next-line no-await-in-loop
      await assertPeerDependencies(folder, parent ? join(parent, entry) : entry)
      continue
    }

    const externalName = join(parent, entry.split('@')[0])

    if (!externalDeps.has(externalName)) continue

    const versionPkgJsonPath = join(folder, 'package.json')
    const versionPkgJson = require(versionPkgJsonPath)

    let pkgJsonPath
    let pkgJson

    for (const { dep, name, node, forced, version } of externalDeps.get(externalName)) {
      if (node && !semver.satisfies(process.versions.node, node)) {
        continue
      }
      if (!pkgJsonPath) {
        pkgJsonPath = require(folder).pkgJsonPath()
        pkgJson = require(pkgJsonPath)
      }

      for (const section of ['devDependencies', 'peerDependencies']) {
        if (pkgJson[section]?.[name]) {
          if (dep === externalName) {
            versionPkgJson.dependencies[name] = pkgJson.version
          } else {
            const range = pkgJson[section][name].includes('||')
              // Use the first version in the list (as npm does by default)
              ? pkgJson[section][name].split('||')[0].trim()
              // Only one version available so use that.
              : pkgJson[section][name]
            versionPkgJson.dependencies[name] = resolveLatestSatisfying(name, range)
          }
          break
        }
      }

      if (!versionPkgJson.dependencies[name] && forced) {
        versionPkgJson.dependencies[name] = version || latests[name]
      }
    }

    // eslint-disable-next-line no-await-in-loop
    await writeFile(versionPkgJsonPath, JSON.stringify(versionPkgJson, null, 2))
  }
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
 * @param {boolean} [retry]
 */
function install (retry = true) {
  try {
    exec('bun install --trust', { cwd: folder() })
  } catch (err) {
    if (!retry) throw err
    install(false) // retry in case of server error from registry
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
