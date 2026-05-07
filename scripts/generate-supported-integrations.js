'use strict'

const { readFileSync, writeFileSync } = require('node:fs')
const { builtinModules } = require('node:module')
const path = require('node:path')

// eslint-disable-next-line n/no-restricted-require
const semver = require('semver')

const CHECK_FLAG = '--check'
const FETCH_TIMEOUT_MS = 3000

const ROOT = path.join(__dirname, '..')
const PLUGINS_INDEX = path.join(ROOT, 'packages/dd-trace/src/plugins/index.js')
const ROOT_PACKAGE = path.join(ROOT, 'package.json')
const VERSIONS_PACKAGE = path.join(ROOT, 'packages/dd-trace/test/plugins/versions/package.json')
const INSTRUMENTATION_HOOKS = path.join(ROOT, 'packages/datadog-instrumentations/src/helpers/hooks.js')
const INSTRUMENTATION_REGISTRY = path.join(ROOT, 'packages/datadog-instrumentations/src/helpers/instrumentations.js')

const JSON_OUTPUT_PATH = path.join(ROOT, 'supported_versions_output.json')
const CSV_OUTPUT_PATH = path.join(ROOT, 'supported_versions_table.csv')

const COLUMNS = [
  'dependency',
  'integration',
  'minimum_tracer_supported',
  'max_tracer_supported',
  'auto-instrumented',
]

const NODE_BUILTINS = new Set(builtinModules)

// Capture `get '<key>' () { return require('.../datadog-plugin-<name>/src') }`
// (and the bare-key form) from packages/dd-trace/src/plugins/index.js. Keys
// like `./runtime/library.js` and `global:fetch` are not user-installable
// packages, so they're filtered out here.
const PLUGIN_GETTER =
  /get\s+(?:'((?!\.{1,2}\/|global:)[^']+)'|((?!\.{1,2}\/|global:)[\w$]+))\s*\(\s*\)\s*\{\s*return\s+require\([^)]*datadog-plugin-([^'")]+?)\/src/g

function isBuiltin (dependency) {
  return dependency.startsWith('node:') || NODE_BUILTINS.has(dependency)
}

/**
 * @returns {Map<string, string>} Dependency name (npm/builtin) -> plugin directory name.
 */
function readPluginMap () {
  const source = readFileSync(PLUGINS_INDEX, 'utf8')
  const map = new Map()
  for (const [, quoted, bare, plugin] of source.matchAll(PLUGIN_GETTER)) {
    map.set(quoted ?? bare, plugin)
  }
  if (map.size === 0) {
    throw new Error(`No plugin getters in ${path.relative(ROOT, PLUGINS_INDEX)}`)
  }
  return map
}

/**
 * @param {{ min: string, maxMajor: number | undefined }} engines
 * @returns {Map<string, Set<string>>}
 */
function readInstrumentationRanges (engines) {
  const profiles = new Set()
  if (engines.min) profiles.add(engines.min)
  if (engines.maxMajor !== undefined) profiles.add(`${engines.maxMajor}.0.0`)

  const registry = require(INSTRUMENTATION_REGISTRY)
  const hookFactories = Object.values(require(INSTRUMENTATION_HOOKS))
  const ranges = new Map()

  for (const profile of profiles) {
    Object.defineProperty(process.versions, 'node', { value: profile, configurable: true })

    // `helpers/instrument.js` closes over the registry reference, so reset
    // the registry in place; drop the other instrumentation sources so they
    // re-execute and re-evaluate `MIN_VERSION` under the simulated Node.
    for (const key of Object.keys(registry)) delete registry[key]
    for (const cached of Object.keys(require.cache)) {
      if ((cached.includes('/datadog-instrumentations/src/') && !cached.includes('/helpers/')) ||
          cached.endsWith('/version.js')) {
        delete require.cache[cached]
      }
    }

    for (const value of hookFactories) {
      const factory = typeof value === 'function' ? value : value.fn
      factory?.()
    }

    for (const [name, entries] of Object.entries(registry)) {
      const set = ranges.get(name) ?? new Set()
      for (const { versions } of entries) {
        if (!Array.isArray(versions)) continue
        for (const range of versions) {
          if (range) set.add(range)
        }
      }
      if (set.size > 0) ranges.set(name, set)
    }
  }
  return ranges
}

/**
 * @param {Set<string> | undefined} ranges
 * @returns {string} Lowest version satisfying any of the given ranges, or `''`.
 */
function lowestVersion (ranges) {
  let lowest
  for (const range of ranges ?? []) {
    const candidate = semver.minVersion(range)
    if (candidate && (!lowest || semver.lt(candidate, lowest))) lowest = candidate
  }
  return lowest?.version ?? ''
}

/**
 * Resolve the lower bound and the highest tracked major from a semver range
 * (e.g. `>=18 <26` -> `{ min: '18.0.0', maxMajor: 25 }`).
 *
 * @param {string} engines
 * @returns {{ min: string, maxMajor: number | undefined }}
 */
function parseEnginesRange (engines) {
  let maxMajor
  for (const comparators of new semver.Range(engines).set) {
    for (const { operator, semver: bound } of comparators) {
      if (!bound || (operator !== '<' && operator !== '<=')) continue
      const candidate = operator === '<' ? bound.major - 1 : bound.major
      if (maxMajor === undefined || candidate > maxMajor) maxMajor = candidate
    }
  }
  return { min: semver.minVersion(engines)?.version ?? '', maxMajor }
}

/**
 * Latest released patch on the given Node.js major line, looked up via the
 * tiny SHASUMS256 file that nodejs.org redirects to the newest release.
 * Returns `undefined` on any network/parse failure.
 *
 * @param {number} major
 * @returns {Promise<string | undefined>}
 */
async function fetchLatestNodeVersion (major) {
  try {
    const response = await fetch(
      `https://nodejs.org/dist/latest-v${major}.x/SHASUMS256.txt`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    )
    if (!response.ok) return
    const body = await response.text()
    return body.match(/node-v(\d+\.\d+\.\d+)-/)?.[1]
  } catch { /* offline or transient: fall through to the persisted value */ }
}

/**
 * @returns {string | undefined} Last `max_tracer_supported` recorded for a
 *   node built-in, used as the offline fallback for `fetchLatestNodeVersion`.
 */
function readPersistedBuiltinMax () {
  try {
    for (const row of JSON.parse(readFileSync(JSON_OUTPUT_PATH, 'utf8'))) {
      if (row.max_tracer_supported && isBuiltin(row.dependency)) return row.max_tracer_supported
    }
  } catch { /* missing or unreadable */ }
}

/**
 * @param {Map<string, string>} plugins
 * @param {Map<string, Set<string>>} ranges
 * @param {Record<string, string>} versions
 * @param {{ min: string, max: string }} nodeRange
 */
function buildRows (plugins, ranges, versions, nodeRange) {
  const rows = []
  for (const [dependency, integration] of plugins) {
    const builtin = isBuiltin(dependency)
    const min = builtin ? nodeRange.min : lowestVersion(ranges.get(dependency))
    const max = builtin ? nodeRange.max : versions[dependency] ?? ''
    if (min && max) {
      rows.push({
        dependency,
        integration,
        minimum_tracer_supported: min,
        max_tracer_supported: max,
        'auto-instrumented': 'True',
      })
    }
  }
  return rows.sort((a, b) =>
    a.dependency.localeCompare(b.dependency) || a.integration.localeCompare(b.integration)
  )
}

function toCsv (rows) {
  const header = COLUMNS.join(',')
  const body = rows.map(row => COLUMNS.map(column => row[column]).join(','))
  return [header, ...body, ''].join('\n')
}

async function generateSupportedIntegrations () {
  const plugins = readPluginMap()
  const engines = parseEnginesRange(JSON.parse(readFileSync(ROOT_PACKAGE, 'utf8')).engines.node)
  const ranges = readInstrumentationRanges(engines)
  const versions = JSON.parse(readFileSync(VERSIONS_PACKAGE, 'utf8')).dependencies ?? {}

  const max = engines.maxMajor === undefined
    ? ''
    : await fetchLatestNodeVersion(engines.maxMajor) ||
      readPersistedBuiltinMax() ||
      `${engines.maxMajor}.0.0`

  const rows = buildRows(plugins, ranges, versions, { min: engines.min, max })

  return {
    rows,
    json: JSON.stringify(rows, null, 2) + '\n',
    csv: toCsv(rows),
  }
}

async function writeSupportedIntegrations () {
  const { json, csv } = await generateSupportedIntegrations()
  writeFileSync(JSON_OUTPUT_PATH, json)
  writeFileSync(CSV_OUTPUT_PATH, csv)
}

function reportDrift (file, expected) {
  if (readFileSync(file, 'utf8').replaceAll('\r\n', '\n') === expected) return false
  // eslint-disable-next-line no-console
  console.error(`Out of date: ${path.relative(ROOT, file)}`)
  return true
}

async function checkSupportedIntegrations () {
  const { json, csv } = await generateSupportedIntegrations()
  // Run both checks before short-circuiting so all stale paths are reported.
  const jsonStale = reportDrift(JSON_OUTPUT_PATH, json)
  const csvStale = reportDrift(CSV_OUTPUT_PATH, csv)
  if (!jsonStale && !csvStale) return true
  // eslint-disable-next-line no-console
  console.error('\nRun: npm run generate:supported-integrations')
  return false
}

if (require.main === module) {
  if (process.argv.includes(CHECK_FLAG)) {
    checkSupportedIntegrations().then(ok => {
      process.exitCode = ok ? 0 : 1
    })
  } else {
    writeSupportedIntegrations()
  }
}

module.exports = {
  CSV_OUTPUT_PATH,
  JSON_OUTPUT_PATH,
  checkSupportedIntegrations,
  generateSupportedIntegrations,
  writeSupportedIntegrations,
}
