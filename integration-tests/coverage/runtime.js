'use strict'

const { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } = require('node:fs')
const fs = require('node:fs/promises')
const path = require('node:path')
const { fileURLToPath } = require('node:url')

const COLLECTOR_ENV = 'DD_TRACE_INTEGRATION_COVERAGE_COLLECTOR'
// Presence of ROOT_ENV is the sole activation signal: the top-level Mocha process seeds it
// with REPO_ROOT; every spawn routed through `applyCoverageEnv` overwrites it with the
// child's resolved dd-trace root so grandchildren inherit the correct root automatically.
const ROOT_ENV = 'DD_TRACE_INTEGRATION_COVERAGE_ROOT'
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const DEFAULT_COLLECTOR_ROOT = path.join(REPO_ROOT, 'coverage', 'integration-tests')
const CHILD_BOOTSTRAP_PATH = path.join(__dirname, 'child-bootstrap.js')
const BOOTSTRAP_REQUIRE_ARG = `--require=${CHILD_BOOTSTRAP_PATH}`

const packageNameCache = new Map()
const rootCache = new Map()

/**
 * @param {string} value
 * @returns {string}
 */
function canonicalizePath (value) {
  try {
    return realpathSync(value)
  } catch {
    return value
  }
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function isCoverageActive (env = process.env) {
  return Boolean(env[ROOT_ENV])
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function getCollectorRoot (env = process.env) {
  return env[COLLECTOR_ENV] || DEFAULT_COLLECTOR_ROOT
}

/**
 * @returns {string}
 */
function resetCollectorRoot () {
  const collectorRoot = getCollectorRoot()
  rmSync(collectorRoot, { force: true, recursive: true })
  mkdirSync(path.join(collectorRoot, 'sandboxes'), { recursive: true })
  return collectorRoot
}

/**
 * @returns {Promise<string>}
 */
async function ensureCollectorRoot () {
  const collectorRoot = getCollectorRoot()
  await fs.mkdir(path.join(collectorRoot, 'sandboxes'), { recursive: true })
  return collectorRoot
}

/**
 * @param {string} folder
 * @returns {string}
 */
function getSandboxCollectorDir (folder) {
  return path.join(getCollectorRoot(), 'sandboxes', path.basename(folder))
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
  try {
    name = JSON.parse(readFileSync(filename, 'utf8')).name
  } catch {}

  packageNameCache.set(filename, name)
  return name
}

/**
 * Walks up the directory tree looking for a `dd-trace` package root, either at `<dir>/` itself
 * or nested as `<dir>/node_modules/dd-trace/`.
 *
 * @param {string} directory
 * @returns {string | undefined}
 */
function findDdTraceRoot (directory) {
  const normalized = canonicalizePath(directory)
  if (rootCache.has(normalized)) return rootCache.get(normalized)

  let result
  let current = normalized
  while (true) {
    const nested = path.join(current, 'node_modules', 'dd-trace', 'package.json')
    if (existsSync(nested) && readPackageName(nested) === 'dd-trace') {
      result = path.dirname(nested)
      break
    }

    const own = path.join(current, 'package.json')
    if (existsSync(own) && readPackageName(own) === 'dd-trace') {
      result = current
      break
    }

    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  rootCache.set(normalized, result)
  return result
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

    const coverageRoot = findDdTraceRoot(candidate)
    if (coverageRoot) return coverageRoot
  }
}

/**
 * @param {string | undefined} nodeOptions
 * @returns {string}
 */
function appendBootstrapRequire (nodeOptions) {
  if (nodeOptions?.includes(CHILD_BOOTSTRAP_PATH)) return nodeOptions
  return nodeOptions ? `${nodeOptions} ${BOOTSTRAP_REQUIRE_ARG}` : BOOTSTRAP_REQUIRE_ARG
}

/**
 * Returns a new env carrying the coverage activation flags plus a `NODE_OPTIONS` that preloads
 * `child-bootstrap.js`. Returns the original env unchanged when coverage is off or the dd-trace
 * root can't be resolved from the given context.
 *
 * @param {NodeJS.ProcessEnv | undefined} env
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {string | URL} [options.scriptPath]
 * @returns {NodeJS.ProcessEnv | undefined}
 */
function applyCoverageEnv (env, options = {}) {
  if (!isCoverageActive()) return env

  const coverageRoot = resolveCoverageRoot(options)
  if (!coverageRoot) return env

  const baseEnv = env || process.env
  return {
    ...baseEnv,
    [ROOT_ENV]: canonicalizePath(coverageRoot),
    NODE_OPTIONS: appendBootstrapRequire(baseEnv.NODE_OPTIONS),
  }
}

module.exports = {
  CHILD_BOOTSTRAP_PATH,
  COLLECTOR_ENV,
  REPO_ROOT,
  ROOT_ENV,
  appendBootstrapRequire,
  applyCoverageEnv,
  canonicalizePath,
  ensureCollectorRoot,
  getCollectorRoot,
  getSandboxCollectorDir,
  getSandboxNycPaths,
  isCoverageActive,
  resetCollectorRoot,
  resolveCoverageRoot,
}
