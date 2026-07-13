'use strict'

const { execFileSync } = require('child_process')
const { createHash } = require('crypto')
const { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('fs')
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

const versionsBunConfig = readFileSync(join(__dirname, '..', 'versions', 'bunfig.toml'), 'utf8')
const minimumReleaseAgeMatch = /^minimumReleaseAge = (\d+)$/m.exec(versionsBunConfig)
// The tracked config is the policy source and is validated by the migration regression test.
/* istanbul ignore if */
/* c8 ignore next */
if (!minimumReleaseAgeMatch) throw new Error('versions/bunfig.toml must define minimumReleaseAge')
const minimumReleaseTimestamp = Date.now() - Number(minimumReleaseAgeMatch[1]) * 1000

// Generating the whole versions/ tree is thousands of mkdir/writeFile calls; bound them so we never exhaust file
// descriptors (EMFILE). Dependency installation dominates the wall-clock, so a moderate cap costs nothing.
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
  invalidateCacheOnNodeAbiChange()
  await assertPrerequisites()
  install()
  const changed = await assertPeerDependencies(join(__dirname, '..', 'versions'))
  // The second install only does something when peer-dependency patching actually changed a manifest. Targeted
  // installs for plugins without external peer dependencies (the common CI matrix case) skip it entirely.
  if (changed) install()
}

/**
 * Bun's isolated linker keeps a single shared copy of every package under
 * `versions/node_modules/.bun/<name>@<ver>/`, so a native binding compiled
 * during the first `npm run services` (under one Node major) is reused
 * verbatim on the second invocation (under a different Node major) and
 * crashes with `undefined symbol` at load time. Per-workspace nested
 * `node_modules` (the layout the previous package manager used) rebuilt the
 * binding on every install pass and never hit this. Wipe the central store
 * when the Node ABI changes so the next `bun install --trust` reruns
 * lifecycle scripts and rebuilds against the live runtime.
 */
function invalidateCacheOnNodeAbiChange () {
  const versionsDir = join(__dirname, '..', 'versions')
  const nodeAbiFile = join(versionsDir, '.node-abi')
  const currentAbi = process.versions.modules
  let recordedAbi = ''
  try {
    recordedAbi = readFileSync(nodeAbiFile, 'utf8').trim()
  } catch {}
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
          versionPkgJson.dependencies[name] = resolveLatestSatisfying(name, capKnownRange(name, range))
        }
        break
      }
    }

    if (!versionPkgJson.dependencies[name] && forced) {
      const range = capKnownRange(name, version || latests[name])
      versionPkgJson.dependencies[name] = resolveLatestSatisfying(name, range)
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
  await writeFile(filename(null, null, 'package.json'), JSON.stringify({
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
    // Workspace-wide overrides to repair packages whose published manifest
    // declares a transitive that the package's own runtime code does not
    // actually accept. The previous package manager's flat hoist masked
    // this by always serving the highest workspace-installed version of
    // the transitive; bun's isolated linker honours each package's
    // declared range and lands the wrong major in the per-package store.
    // - `q@2.0.0` declares `collections@^2.0.0`, but `q.js` does
    //   `require('collections/shim')`; `shim.js` ships only in
    //   `collections@>=5`, so without this override `q@2`'s spec crashes
    //   with `Cannot find module 'collections/shim'`.
    // - `@langchain/openai@0.0.34`'s manifest declares
    //   `@langchain/core: >0.1.56 <0.3.0`. The recorded openai cassettes
    //   (and the langchain regression specs that send a JSON-message input)
    //   only succeed when bun lands a `0.2.x` core, which is the highest
    //   version in that range. Bun's linker picks the lowest satisfying
    //   version under some conditions (it lands `0.1.63` on the github
    //   runner image but `0.2.36` on macOS), so pin the floor explicitly
    //   for the langchain-openai pair without affecting the
    //   `@langchain/openai@1.x.x` peer constraint resolved elsewhere in
    //   the workspace.
    // - `zod-to-json-schema@>=3.25.0` switched its zod imports to the
    //   `zod/v3` subpath, which only exists in `zod@>=3.25.32` and
    //   `zod@>=4`. `@ai-sdk/ui-utils` (the `ai@4.0.2` UI helper) declares
    //   `zod-to-json-schema: ^3.0.0` and pulls in `zod@^3.0.0` itself, so
    //   the isolated linker lands `zod-to-json-schema@3.25.2` next to a
    //   `zod@3.23.x` that has no `/v3` subpath, crashing at load time
    //   with `Package subpath './v3' is not defined`. The previous
    //   package manager hid this because its flat hoist served the
    //   workspace root's `zod@4` to every consumer. Pin the transitive
    //   globally to the last 3.x release that still imports from `zod`
    //   directly so the `ai@4.x` sandbox loads; the only other consumer
    //   (`langchain`/`langgraph`) declares `zod-to-json-schema >=3.0.0`
    //   and `<3.25.0` satisfies that range too. Bun does not support
    //   nested override keys (oven-sh/bun#6608), so a flat key is
    //   required here even though only the ai sandbox needs it.
    overrides: {
      collections: '^5.0.0',
      '@langchain/openai@0.0.34/@langchain/core': '^0.2.0',
      // limitd-protocol@2.1.1 uses an unprefixed GitHub shorthand that Bun cannot resolve.
      hashlru: 'github:jfromaniello/hashlru#return_value_on_set',
      'zod-to-json-schema': '<3.25.0',
    },
    trustedDependencies: [...trustedDependencies].sort(),
  }, null, 2) + '\n')
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
    // versions/bunfig.toml pins `linker = "isolated"`, which gives every sandbox
    // its own node_modules tree. Several plugin specs hard-code paths into
    // `versions/<plugin>@<ver>/node_modules/<plugin>/<internal>` (kafkajs reaches
    // into `src/broker`, next reads `package.json`, rhea pulls `lib/session.js`);
    // under isolated bun creates a symlink at that path that resolves to the
    // central store, so the lookups work. Cross-workspace dependencies
    // (moleculer's runtime `require('bluebird')` fallback, etc.) are wired
    // through `externals.js` `dep: true, forced: true` so they land as a direct
    // dep of the consuming sandbox rather than as a sibling workspace.
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
  pruneAmbiguousBunCentralSymlinks()
}

/**
 * Bun's isolated linker keeps a central deduplicated
 * `versions/node_modules/.bun/node_modules/` directory holding one symlink per
 * package, pointing at whichever installed version is highest. The directory
 * sits in Node's resolution path from inside `.bun/<pkg>@<ver>/node_modules/<pkg>/...`,
 * so when several incompatible majors of a package are installed across
 * sandboxes (e.g. `pino-pretty@1.0.1` for `pino@5` plus `pino-pretty@13.1.3`
 * for `pino-pretty@>=3`), `pino@5`'s `require('pino-pretty')` picks up the
 * central `13.1.3` symlink and crashes with `pretty is not a function` —
 * which deadlocks the test process because the throw happens inside an
 * internal pino write loop.
 *
 * The previous package manager's nohoist-everything per-workspace layout
 * never had this leak: each sandbox's resolution stopped at the version its
 * own devDependency declared. Mirror that here by removing the central
 * symlink only for packages that have more than one major installed in the
 * `.bun/` store. Single-version packages (e.g. `collections`, `sqlite3`,
 * `@grpc/proto-loader`) keep their hoisted symlink so the legitimate
 * transitive lookups every sandbox relies on still work.
 */
function pruneAmbiguousBunCentralSymlinks () {
  const dotBun = join(__dirname, '..', 'versions', 'node_modules', '.bun')
  const central = join(dotBun, 'node_modules')
  if (!existsSync(central)) return

  const installedMajors = collectInstalledMajors(dotBun)
  for (const [pkg, majors] of installedMajors) {
    if (majors.size <= 1) continue
    rmSync(join(central, pkg), { recursive: true, force: true })
  }
}

/**
 * Build `<package-name> -> Set<majorVersion>` from the names of
 * `versions/node_modules/.bun/<name>@<version>/` directories. Scoped
 * packages encode the slash as `+` in the central store
 * (`@grpc+proto-loader@1.2.3`), so reverse that for the key lookup.
 *
 * @param {string} dotBun
 * @returns {Map<string, Set<string>>}
 */
function collectInstalledMajors (dotBun) {
  /** @type {Map<string, Set<string>>} */
  const byName = new Map()
  for (const entry of readdirSync(dotBun)) {
    if (entry === 'node_modules') continue
    const at = entry.lastIndexOf('@')
    if (at <= 0) continue
    const rawName = entry.slice(0, at)
    const version = entry.slice(at + 1)
    if (!version) continue
    const major = version.split('.')[0]
    const name = rawName.replace('+', '/')
    let majors = byName.get(name)
    if (!majors) {
      majors = new Set()
      byName.set(name, majors)
    }
    majors.add(major)
  }
  return byName
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
 * Resolve a semver range to the highest old-enough published version satisfying it.
 *
 * Bun can select the lowest matching version instead of the highest that the
 * previous package manager picked and every plugin regression test relied on.
 * Without taking the highest
 * we install ancient transitives that, for instance, ship `pino-pretty@1.0.1`
 * into `versions/pino@5.0.0/` (where pino's `prettyPrint: true` then
 * deadlocks the test process) and `@langchain/core@0.1.x` into the
 * langchain sandbox (where `coerceMessageLikeToMessage` rejects the
 * JSON-message regression test). Publication timestamps also have to be
 * filtered here: pinning the newest version before `bun install` would make
 * Bun reject the exact pin instead of selecting the newest old-enough release.
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
  let metadata
  try {
    const options = {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }
    const versions = execFileSync('bun', ['pm', 'view', name, 'versions', '--json'], options).trim()
    const time = execFileSync('bun', ['pm', 'view', name, 'time', '--json'], options).trim()
    metadata = {
      versions: JSON.parse(versions),
      time: JSON.parse(time),
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`bun pm view failed for ${name}: ${error.message}; deferring to install-time resolution`)
    return range
  }
  // npm registry package metadata always exposes the time map.
  /* istanbul ignore if */
  /* c8 ignore next 6 */
  if (!Array.isArray(metadata?.versions) || !metadata.time || typeof metadata.time !== 'object') {
    // eslint-disable-next-line no-console
    console.warn(`bun pm view returned incomplete publication metadata for ${name}: ${JSON.stringify(metadata)}; ` +
      'deferring to install-time resolution')
    return range
  }
  const versions = []
  for (const version of metadata.versions) {
    const publishedAt = metadata.time[version]
    const publishedTimestamp = Date.parse(publishedAt)
    if (!semver.valid(version) || !Number.isFinite(publishedTimestamp) ||
      publishedTimestamp > minimumReleaseTimestamp) continue
    versions.push(version)
  }
  const resolved = semver.maxSatisfying(versions, range, { includePrerelease: false })
  // Whether a supported range has no old-enough release depends on live registry state.
  /* istanbul ignore if */
  /* c8 ignore next 5 */
  if (!resolved) {
    // eslint-disable-next-line no-console
    console.warn(`no old-enough ${name} version satisfies ${range}; deferring to install-time resolution`)
    return range
  }
  resolvedRangeCache.set(cacheKey, resolved)
  return resolved
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
