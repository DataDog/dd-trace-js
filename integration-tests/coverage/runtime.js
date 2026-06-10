'use strict'

const { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')

const FLUSH_SIGNAL_KEY = '__ddCovFlush'
// `_DD_*` marks these as internal to the harness. Test files that opt children out
// reference the name as a literal (`_DD_TRACE_INTEGRATION_COVERAGE_DISABLE: '1'`) so a
// rename here requires updating those tests and `.mocharc.js` / `register.js`.
const COLLECTOR_ENV = '_DD_TRACE_INTEGRATION_COVERAGE_COLLECTOR'
const DISABLE_ENV = '_DD_TRACE_INTEGRATION_COVERAGE_DISABLE'
const ROOT_ENV = '_DD_TRACE_INTEGRATION_COVERAGE_ROOT'
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const CHILD_BOOTSTRAP_PATH = path.join(__dirname, 'child-bootstrap.js')
const BOOTSTRAP_REQUIRE_ARG = `--require=${CHILD_BOOTSTRAP_PATH}`

const PRE_INSTRUMENTED_SENTINEL = '.nyc-pre-instrumented'
// POSIX-style so `path.isAbsolute` matches on both POSIX and Windows.
const PRE_INSTRUMENTED_ROOT = '/__DD_TRACE_PRE_INSTRUMENTED__'

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
 * @returns {string}
 */
function getMergedReportDir () {
  return path.join(REPO_ROOT, 'coverage', `node-${process.version}${labelSuffix()}`)
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
 * @param {string | undefined} coverageRoot
 * @returns {boolean}
 */
function isPreInstrumentedSandbox (coverageRoot) {
  if (!coverageRoot) return false
  return existsSync(path.join(coverageRoot, PRE_INSTRUMENTED_SENTINEL))
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
 * Must be Node's first `--require` so a caller-supplied preloader (e.g. `-r dd-trace/ci/init`)
 * can't run first and leave its module graph uninstrumented.
 *
 * @param {string | undefined} nodeOptions
 * @returns {string}
 */
function prependBootstrapRequire (nodeOptions) {
  if (nodeOptions?.includes(CHILD_BOOTSTRAP_PATH)) return nodeOptions
  return nodeOptions ? `${BOOTSTRAP_REQUIRE_ARG} ${nodeOptions}` : BOOTSTRAP_REQUIRE_ARG
}

/**
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
  BOOTSTRAP_REQUIRE_ARG,
  CHILD_BOOTSTRAP_PATH,
  COLLECTOR_ENV,
  DISABLE_ENV,
  FLUSH_SIGNAL_KEY,
  PRE_INSTRUMENTED_ROOT,
  PRE_INSTRUMENTED_SENTINEL,
  REPO_ROOT,
  ROOT_ENV,
  applyCoverageEnv,
  canonicalizePath,
  getCollectorRoot,
  getMergedReportDir,
  getSandboxCollectorDir,
  getSandboxNycPaths,
  isCoverageActive,
  isPreInstrumentedSandbox,
  prependBootstrapRequire,
  resetCollectorRoot,
  resolveCoverageRoot,
  scriptLabel,
}
