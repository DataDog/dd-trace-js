'use strict'

const { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')

// IPC sentinel `helpers#stopProc` sends to a connected child on Windows, where SIGTERM is forceful
// and skips the signal-flush hook. The child flushes its V8 coverage on receipt and exits cleanly.
const FLUSH_SIGNAL_KEY = '__ddCovFlush'
// `_DD_*` marks these as internal to the harness. Test files that opt children out
// reference the name as a literal (`_DD_TRACE_INTEGRATION_COVERAGE_DISABLE: '1'`) so a
// rename here requires updating those tests and `.mocharc.js` / `register.js`.
const COLLECTOR_ENV = '_DD_TRACE_INTEGRATION_COVERAGE_COLLECTOR'
const DISABLE_ENV = '_DD_TRACE_INTEGRATION_COVERAGE_DISABLE'
const ROOT_ENV = '_DD_TRACE_INTEGRATION_COVERAGE_ROOT'
// Set on a child that already carries a foreign `NODE_V8_COVERAGE` (e.g. a fixture exercising
// Node's own test-runner coverage). We leave the child's directory untouched so its own tooling
// still works, and name our collector here so the child's profiles get copied in on the way out.
const COPY_BACK_ENV = '_DD_TRACE_INTEGRATION_COVERAGE_COPY_BACK'
// Node writes one raw V8 coverage JSON per process into the directory named by this variable.
// We point every process in the tree at a shared directory so a single pass converts them all.
const V8_COVERAGE_ENV = 'NODE_V8_COVERAGE'
const REPO_ROOT = path.resolve(__dirname, '..', '..')

// Preloaded into every Node descendant via NODE_OPTIONS. Under V8 coverage it does no
// instrumentation — V8 collects automatically from NODE_V8_COVERAGE — it only re-installs the
// child_process / worker_threads patch so a grandchild spawned with a *custom* env (which would
// otherwise drop the inherited NODE_V8_COVERAGE) still has the directory injected.
const CHILD_BOOTSTRAP_PATH = path.join(__dirname, 'child-bootstrap.js')
const BOOTSTRAP_REQUIRE_ARG = `--require=${CHILD_BOOTSTRAP_PATH}`

const packageNameCache = new Map()
const rootCache = new Map()

/**
 * @param {string} value
 * @returns {string}
 */
function canonicalizePath (value) {
  try { return realpathSync(value) } catch { return value }
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function isCoverageActive (env = process.env) {
  return Boolean(env[ROOT_ENV])
}

/**
 * @returns {string}
 */
function scriptLabel () {
  const event = process.env.npm_lifecycle_event ?? ''
  return event.replaceAll(/[^a-zA-Z0-9._-]+/g, '-')
}

/**
 * @returns {string}
 */
function labelSuffix () {
  const label = scriptLabel()
  return label ? `-${label}` : ''
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function getCollectorRoot (env = process.env) {
  if (env[COLLECTOR_ENV]) return env[COLLECTOR_ENV]
  return path.join(REPO_ROOT, '.nyc_output', `integration-tests-collector${labelSuffix()}`)
}

/**
 * @returns {string}
 */
function resetCollectorRoot () {
  const root = getCollectorRoot()
  rmSync(root, { force: true, recursive: true })
  mkdirSync(getV8CoverageDir(root), { recursive: true })
  return root
}

/**
 * Directory every process in the tree writes its raw V8 coverage JSON into. A single shared
 * directory (rather than per-sandbox dirs) lets the finalize step convert and merge in one pass,
 * and survives sandbox teardown because it lives under the repo-root collector, not the sandbox.
 *
 * @param {string} [collectorRoot]
 * @returns {string}
 */
function getV8CoverageDir (collectorRoot = getCollectorRoot()) {
  return path.join(collectorRoot, 'v8')
}

/**
 * Copy every raw V8 profile from `fromDir` into `toDir`, prefixing each file name so profiles from
 * different source directories can't collide (V8 names them `coverage-<pid>-<ts>-<seq>.json`, which
 * repeats across trees). Used to fold a child's own `NODE_V8_COVERAGE` output into our collector
 * when we left that variable untouched. Synchronous and best-effort: it runs from signal handlers
 * and process teardown where async work is unsafe, and never throws — a missed copy costs coverage,
 * never a failed test.
 *
 * @param {string | undefined} fromDir
 * @param {string | undefined} toDir
 * @returns {number} count of profiles copied
 */
function copyV8ProfilesSync (fromDir, toDir) {
  if (!fromDir || !toDir || fromDir === toDir) return 0
  let copied = 0
  try {
    const prefix = `copied-${process.pid}-`
    for (const name of readdirSync(fromDir)) {
      if (!name.endsWith('.json') || name.startsWith('copied-')) continue
      try {
        copyFileSync(path.join(fromDir, name), path.join(toDir, prefix + name))
        copied++
      } catch {}
    }
  } catch {}
  return copied
}

/**
 * @returns {string}
 */
function getMergedReportDir () {
  return path.join(REPO_ROOT, 'coverage', `node-${process.version}${labelSuffix()}`)
}

/**
 * @param {string | URL | undefined} value
 * @param {string} [cwd]
 * @returns {string | undefined}
 */
function toPath (value, cwd) {
  if (!value) return
  if (value instanceof URL) return canonicalizePath(fileURLToPath(value))
  if (typeof value !== 'string') return
  return canonicalizePath(path.resolve(cwd || process.cwd(), value))
}

/**
 * @param {string} filename
 * @returns {string | undefined}
 */
function readPackageName (filename) {
  if (packageNameCache.has(filename)) return packageNameCache.get(filename)
  let name
  try { name = JSON.parse(readFileSync(filename, 'utf8')).name } catch {}
  packageNameCache.set(filename, name)
  return name
}

/**
 * Walks up from `directory` looking for a `dd-trace` package root. Only positive results are
 * cached — `execSync` patching re-enters here before dd-trace is installed, and caching a
 * miss would blind later tear-down lookups.
 *
 * @param {string} directory
 * @returns {string | undefined}
 */
function findDdTraceRoot (directory) {
  const normalized = canonicalizePath(directory)
  const cached = rootCache.get(normalized)
  if (cached) return cached

  let current = normalized
  while (true) {
    const nested = path.join(current, 'node_modules', 'dd-trace', 'package.json')
    if (existsSync(nested) && readPackageName(nested) === 'dd-trace') {
      const result = path.dirname(nested)
      rootCache.set(normalized, result)
      return result
    }
    const own = path.join(current, 'package.json')
    if (existsSync(own) && readPackageName(own) === 'dd-trace') {
      rootCache.set(normalized, current)
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

/**
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {string | URL} [options.scriptPath]
 * @returns {string | undefined}
 */
function resolveCoverageRoot (options = {}) {
  const scriptPath = toPath(options.scriptPath, options.cwd)
  const candidates = [
    scriptPath ? path.dirname(scriptPath) : undefined,
    toPath(options.cwd),
    process.env[ROOT_ENV],
    process.cwd(),
  ]

  const seen = new Set()
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    const root = findDdTraceRoot(candidate)
    if (root) return root
  }
}

/**
 * Prepend the bootstrap require to an existing NODE_OPTIONS. Must be first so a caller-supplied
 * preloader (e.g. `-r dd-trace/ci/init`) can't run before the child_process patch is reinstalled.
 *
 * @param {string | undefined} nodeOptions
 * @returns {string}
 */
function prependBootstrapRequire (nodeOptions) {
  if (nodeOptions?.includes(CHILD_BOOTSTRAP_PATH)) return nodeOptions
  return nodeOptions ? `${BOOTSTRAP_REQUIRE_ARG} ${nodeOptions}` : BOOTSTRAP_REQUIRE_ARG
}

/**
 * Overlay the coverage env onto a child's environment so it (and its descendants) collect native
 * V8 coverage into the shared collector directory. Prepends the bootstrap require to `NODE_OPTIONS`
 * (so the child re-patches child_process and the coverage env keeps flowing into grandchildren
 * spawned with a custom env) and carries `ROOT_ENV` so descendants keep recognising coverage as
 * active.
 *
 * `NODE_V8_COVERAGE` is not a private harness channel — Node's own test runner, c8 and other tools
 * read it from the child env. So we only *set* it when the child does not already carry one; a
 * child that brought its own directory (e.g. a fixture running `node --test
 * --experimental-test-coverage`) keeps it, and we record our collector in `COPY_BACK_ENV` instead
 * so `child-bootstrap`/`stopProc` fold that child's profiles into the collector on the way out.
 * Overwriting unconditionally would silently redirect the fixture's own coverage — usually leaving
 * its assertions green against empty data.
 *
 * A child that sets `DISABLE_ENV` opts its whole subtree out: `ROOT_ENV`/`COPY_BACK_ENV` are
 * stripped, and `NODE_V8_COVERAGE` is blanked only when it is the directory *we* injected (Node
 * copies the parent's value to a child even when a custom env omits it, so omitting is not enough),
 * while a foreign directory the child set itself is preserved.
 *
 * @param {NodeJS.ProcessEnv | undefined} env
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {string | URL} [options.scriptPath]
 * @returns {NodeJS.ProcessEnv | undefined}
 */
function applyCoverageEnv (env, options = {}) {
  if (!isCoverageActive()) return env
  const baseEnv = env || process.env
  const ownDir = getV8CoverageDir()
  if (baseEnv[DISABLE_ENV]) {
    const { [ROOT_ENV]: _root, [COPY_BACK_ENV]: _copyBack, ...rest } = baseEnv
    if (rest[V8_COVERAGE_ENV] === undefined || rest[V8_COVERAGE_ENV] === ownDir) rest[V8_COVERAGE_ENV] = ''
    return rest
  }
  const root = resolveCoverageRoot(options)
  if (!root) return env
  const childDir = baseEnv[V8_COVERAGE_ENV]
  if (childDir && childDir !== ownDir) {
    // Leave the child's own directory in place; copy its profiles into our collector on exit.
    const { [COPY_BACK_ENV]: _drop, ...rest } = baseEnv
    return {
      ...rest,
      [ROOT_ENV]: canonicalizePath(root),
      [COPY_BACK_ENV]: ownDir,
      NODE_OPTIONS: prependBootstrapRequire(baseEnv.NODE_OPTIONS),
    }
  }
  const { [COPY_BACK_ENV]: _drop, ...rest } = baseEnv
  return {
    ...rest,
    [ROOT_ENV]: canonicalizePath(root),
    [V8_COVERAGE_ENV]: ownDir,
    NODE_OPTIONS: prependBootstrapRequire(baseEnv.NODE_OPTIONS),
  }
}

module.exports = {
  BOOTSTRAP_REQUIRE_ARG,
  CHILD_BOOTSTRAP_PATH,
  COLLECTOR_ENV,
  COPY_BACK_ENV,
  DISABLE_ENV,
  FLUSH_SIGNAL_KEY,
  REPO_ROOT,
  ROOT_ENV,
  V8_COVERAGE_ENV,
  applyCoverageEnv,
  canonicalizePath,
  copyV8ProfilesSync,
  getCollectorRoot,
  getMergedReportDir,
  getV8CoverageDir,
  isCoverageActive,
  prependBootstrapRequire,
  resetCollectorRoot,
  resolveCoverageRoot,
  scriptLabel,
}
