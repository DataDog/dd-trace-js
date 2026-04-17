'use strict'

const { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')

// IPC sentinel `helpers#stopProc` sends on Windows to trigger nyc's exit hook.
const FLUSH_SIGNAL_KEY = '__ddCovFlush'
const COLLECTOR_ENV = 'DD_TRACE_INTEGRATION_COVERAGE_COLLECTOR'
// Per-spawn opt-out. Callers set this in the child env they pass to `fork`/`exec`/`spawn`
// when the child must not carry the coverage bootstrap (e.g. timing-sensitive fixtures
// whose semantics break once nyc's require-hook doubles child startup time).
const DISABLE_ENV = 'DD_TRACE_INTEGRATION_COVERAGE_DISABLE'
// Presence of ROOT_ENV activates the coverage harness for a process tree.
const ROOT_ENV = 'DD_TRACE_INTEGRATION_COVERAGE_ROOT'
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const CHILD_BOOTSTRAP_PATH = path.join(__dirname, 'child-bootstrap.js')
const BOOTSTRAP_REQUIRE_ARG = `--require=${CHILD_BOOTSTRAP_PATH}`

// Multiply test timeouts by this factor when running under coverage. 3x is the smallest
// value that stayed green across all known coverage-sensitive tests on GitHub runners
// (OpenTelemetry telemetry heartbeats, Mocha telemetry intake payloads, DI probe logs).
const COVERAGE_SLOWDOWN = process.env[ROOT_ENV] ? 3 : 1

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
 * Slug of the active `npm_lifecycle_event`. Used to scope every per-run artifact so parallel
 * `*:coverage` scripts never share scratch or final output.
 *
 * @returns {string}
 */
function scriptLabel () {
  const event = process.env.npm_lifecycle_event ?? ''
  return event.replaceAll(/[^a-zA-Z0-9._-]+/g, '-')
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function getCollectorRoot (env = process.env) {
  if (env[COLLECTOR_ENV]) return env[COLLECTOR_ENV]
  const label = scriptLabel()
  const name = label ? `integration-tests-collector-${label}` : 'integration-tests-collector'
  return path.join(REPO_ROOT, '.nyc_output', name)
}

/**
 * @returns {string}
 */
function resetCollectorRoot () {
  const root = getCollectorRoot()
  rmSync(root, { force: true, recursive: true })
  mkdirSync(path.join(root, 'sandboxes'), { recursive: true })
  return root
}

/**
 * @param {string} folder
 * @returns {string}
 */
function getSandboxCollectorDir (folder) {
  return path.join(getCollectorRoot(), 'sandboxes', path.basename(folder))
}

/**
 * Mirrors `nyc.config.js` (`coverage/node-${version}${label}`) so Codecov discovery and
 * `scripts/verify-coverage.js` treat integration and unit reports identically.
 *
 * @returns {string}
 */
function getMergedReportDir () {
  const label = scriptLabel()
  const suffix = label ? `-${label}` : ''
  return path.join(REPO_ROOT, 'coverage', `node-${process.version}${suffix}`)
}

/**
 * @param {string} coverageRoot
 * @returns {{ reportDir: string, tempDir: string }}
 */
function getSandboxNycPaths (coverageRoot) {
  return {
    reportDir: path.join(coverageRoot, 'coverage', 'integration-tests'),
    tempDir: path.join(coverageRoot, '.nyc_output', 'integration-tests'),
  }
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
 * Walks up from `directory` looking for a `dd-trace` package root, either at the directory
 * itself or nested as `<dir>/node_modules/dd-trace/`. Only positive results are cached —
 * `execSync` patching re-enters here during sandbox bring-up before dd-trace is installed,
 * and caching that miss would blind later tear-down lookups.
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
    options.cwd ? toPath(options.cwd) : undefined,
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
 * Must be Node's FIRST `--require`. Otherwise a caller-provided preloader (e.g.
 * `-r dd-trace/ci/init`) runs before nyc's require hook, leaving its module graph
 * uninstrumented.
 *
 * @param {string | undefined} nodeOptions
 * @returns {string}
 */
function prependBootstrapRequire (nodeOptions) {
  if (nodeOptions?.includes(CHILD_BOOTSTRAP_PATH)) return nodeOptions
  return nodeOptions ? `${BOOTSTRAP_REQUIRE_ARG} ${nodeOptions}` : BOOTSTRAP_REQUIRE_ARG
}

/**
 * Returns a new env with the coverage activation flags + a `NODE_OPTIONS` that preloads
 * `child-bootstrap.js`. Returns the original env unchanged when coverage is off or the
 * dd-trace root can't be resolved from the given context.
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
  if (baseEnv[DISABLE_ENV]) {
    // Strip any inherited `ROOT_ENV` so `child-bootstrap.js` (if it somehow still loads)
    // short-circuits and grandchildren stay untouched.
    const { [ROOT_ENV]: _omit, ...rest } = baseEnv
    return rest
  }
  const root = resolveCoverageRoot(options)
  if (!root) return env
  return {
    ...baseEnv,
    [ROOT_ENV]: canonicalizePath(root),
    NODE_OPTIONS: prependBootstrapRequire(baseEnv.NODE_OPTIONS),
  }
}

module.exports = {
  CHILD_BOOTSTRAP_PATH,
  COLLECTOR_ENV,
  COVERAGE_SLOWDOWN,
  DISABLE_ENV,
  FLUSH_SIGNAL_KEY,
  REPO_ROOT,
  ROOT_ENV,
  applyCoverageEnv,
  canonicalizePath,
  getCollectorRoot,
  getMergedReportDir,
  getSandboxCollectorDir,
  getSandboxNycPaths,
  isCoverageActive,
  prependBootstrapRequire,
  resetCollectorRoot,
  resolveCoverageRoot,
  scriptLabel,
}
