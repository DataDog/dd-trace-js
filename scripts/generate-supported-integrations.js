'use strict'

const { readFileSync, writeFileSync } = require('node:fs')
const { builtinModules } = require('node:module')
const path = require('node:path')

// eslint-disable-next-line n/no-restricted-require
const semver = require('semver')

const {
  brokenVersionReason,
  getCappedRange,
  resolvePluginVersions,
} = require('../packages/dd-trace/test/plugins/versions')
const mapWithConcurrency = require('./helpers/concurrency')

const CHECK_FLAG = '--check'
const NODE_RANGE_FLAG = '--node-range'
const FETCH_TIMEOUT_MS = 10_000
const FETCH_CONCURRENCY = 10

const ROOT = path.join(__dirname, '..')
const PLUGINS_INDEX = path.join(ROOT, 'packages/dd-trace/src/plugins/index.js')
const ROOT_PACKAGE = path.join(ROOT, 'package.json')
const ROOT_VERSION = path.join(ROOT, 'version.js')
const VERSIONS_PACKAGE = path.join(ROOT, 'packages/dd-trace/test/plugins/versions/package.json')
const INSTRUMENTATION_HOOKS = path.join(ROOT, 'packages/datadog-instrumentations/src/helpers/hooks.js')
const INSTRUMENTATION_REGISTRY = path.join(ROOT, 'packages/datadog-instrumentations/src/helpers/instrumentations.js')

const JSON_OUTPUT_PATH = path.join(ROOT, 'supported_versions.json')

const NODE_BUILTINS = new Set(builtinModules.map(name => name.replace(/^node:/, '')))

// Capture `get '<key>' () { return require('.../datadog-plugin-<name>/src') }`
// (and the bare-key form) from packages/dd-trace/src/plugins/index.js. Keys
// like `./runtime/library.js` and `global:fetch` are not user-installable
// packages, so they're filtered out here.
const PLUGIN_GETTER =
  /get\s+(?:'((?!\.{1,2}\/|global:)[^']+)'|((?!\.{1,2}\/|global:)[\w$]+))\s*\(\s*\)\s*\{\s*return\s+require\([^)]*datadog-plugin-([^'")]+?)\/src/g

/**
 * @typedef {object} NodeProfile
 * @property {string} key
 * @property {string} version
 */

/**
 * @typedef {object} PackageInfo
 * @property {{ node?: string }} [engines]
 * @property {number} [nodeMaxMajor]
 */

/**
 * @typedef {object} InstrumentationDeclaration
 * @property {string[]} [versions]
 * @property {string} [node]
 */

/**
 * @typedef {object} GenerationOptions
 * @property {string} [nodeRange]
 * @property {Map<string, string>} [plugins]
 * @property {PackageInfo} [packageInfo]
 * @property {Record<string, string>} [versions]
 * @property {NodeProfile[]} [nodeProfiles]
 * @property {Map<string, Map<string, InstrumentationDeclaration[]>>} [instrumentations]
 * @property {(dependency: string) => Promise<string[]>} [getPackageVersions]
 * @property {string} [outputPath]
 */

/**
 * @param {string} dependency
 * @returns {boolean}
 */
function isBuiltin (dependency) {
  return NODE_BUILTINS.has(dependency.replace(/^node:/, ''))
}

/**
 * @param {string} dependency
 * @returns {string}
 */
function normalizeDependency (dependency) {
  return dependency.startsWith('node:') || !isBuiltin(dependency) ? dependency : `node:${dependency}`
}

/**
 * @returns {Map<string, string>} Dependency name (npm/builtin) -> plugin directory name.
 */
function readPluginMap () {
  const source = readFileSync(PLUGINS_INDEX, 'utf8')
  const map = new Map()
  for (const [, quoted, bare, plugin] of source.matchAll(PLUGIN_GETTER)) {
    map.set(normalizeDependency(quoted ?? bare), plugin)
  }
  if (map.size === 0) {
    throw new Error(`No plugin getters in ${path.relative(ROOT, PLUGINS_INDEX)}`)
  }
  return map
}

/**
 * @param {string} cached
 * @returns {boolean}
 */
function isRuntimeSpecificInstrumentation (cached) {
  return (cached.includes('/datadog-instrumentations/src/') && !cached.includes('/helpers/')) ||
    cached === ROOT_VERSION
}

/**
 * @param {NodeProfile[]} nodeProfiles
 * @returns {Map<string, Map<string, InstrumentationDeclaration[]>>}
 */
function readInstrumentations (nodeProfiles) {
  const registry = require(INSTRUMENTATION_REGISTRY)
  const hookFactories = Object.values(require(INSTRUMENTATION_HOOKS))
  const originalNodeVersion = Object.getOwnPropertyDescriptor(process.versions, 'node')
  const originalRegistry = { ...registry }
  const originalCache = new Map()
  const instrumentations = new Map()

  for (const cached of Object.keys(require.cache)) {
    if (isRuntimeSpecificInstrumentation(cached)) originalCache.set(cached, require.cache[cached])
  }

  try {
    for (const { version } of nodeProfiles) {
      Object.defineProperty(process.versions, 'node', { value: version, configurable: true })

      // Hook modules evaluate their Node.js gates at load time, while addHook closes over this registry object.
      for (const key of Object.keys(registry)) delete registry[key]
      for (const cached of Object.keys(require.cache)) {
        if (isRuntimeSpecificInstrumentation(cached)) delete require.cache[cached]
      }

      for (const value of hookFactories) {
        const factory = typeof value === 'function' ? value : value.fn
        factory?.()
      }

      const byDependency = new Map()
      for (const [name, entries] of Object.entries(registry)) {
        byDependency.set(name, [...entries])
      }
      instrumentations.set(version, byDependency)
    }
  } finally {
    for (const key of Object.keys(registry)) delete registry[key]
    Object.assign(registry, originalRegistry)

    for (const cached of Object.keys(require.cache)) {
      if (isRuntimeSpecificInstrumentation(cached)) delete require.cache[cached]
    }
    for (const [cached, module] of originalCache) require.cache[cached] = module

    if (originalNodeVersion) Object.defineProperty(process.versions, 'node', originalNodeVersion)
  }

  return instrumentations
}

/**
 * @param {PackageInfo} packageInfo
 * @param {Record<string, string>} versions
 * @param {string} nodeRange
 * @returns {NodeProfile[]}
 */
function readNodeProfiles (packageInfo, versions, nodeRange) {
  const releaseRange = [
    packageInfo.engines?.node,
    packageInfo.nodeMaxMajor === undefined ? undefined : `<${packageInfo.nodeMaxMajor}`,
  ]
    .filter(Boolean)
    .join(' ')

  if (!semver.validRange(nodeRange)) throw new Error(`Invalid Node.js version range: ${nodeRange}`)

  const profiles = new Map()
  for (const [name, alias] of Object.entries(versions)) {
    const nameMatch = name.match(/^node-(\d+)$/)
    const aliasMatch = alias.match(/^npm:node@(\d+\.\d+\.\d+)$/)
    if (!nameMatch || !aliasMatch) continue

    const version = aliasMatch[1]
    if (releaseRange && !semver.satisfies(version, releaseRange)) continue
    if (!semver.satisfies(version, nodeRange)) continue
    profiles.set(nameMatch[1], version)
  }

  const result = []
  for (const [key, version] of profiles) result.push({ key, version })
  result.sort((left, right) => Number(left.key) - Number(right.key))

  if (result.length === 0) {
    throw new Error(`No tested Node.js versions satisfy '${releaseRange}' and '${nodeRange}'`)
  }
  return result
}

/**
 * @param {string} dependency
 * @returns {Promise<string[]>}
 */
async function fetchPackageVersions (dependency) {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(dependency)}`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
  )
  if (!response.ok) {
    throw new Error(`Could not read npm metadata for '${dependency}': ${response.status} ${response.statusText}`)
  }

  const packument = await response.json()
  return Object.keys(packument.versions ?? {})
}

/**
 * @param {string} supportedRange
 * @returns {string}
 */
function simplifySupportedRange (supportedRange) {
  const ranges = [...new Set(supportedRange.split(' || '))]
  const result = []

  for (let index = 0; index < ranges.length; index++) {
    const range = ranges[index]
    let covered = false

    for (let otherIndex = 0; otherIndex < ranges.length; otherIndex++) {
      if (otherIndex === index) continue
      const otherRange = ranges[otherIndex]
      if (!semver.subset(range, otherRange)) continue

      if (!semver.subset(otherRange, range) || otherIndex < index) {
        covered = true
        break
      }
    }

    if (!covered) result.push(range)
  }

  return result.join(' || ')
}

/**
 * @param {string} dependency
 * @param {InstrumentationDeclaration[]} declarations
 * @param {string} nodeVersion
 * @param {string[]} packageVersions
 * @returns {{ supportedRange: string|undefined, tested: string[] }}
 */
function resolveDependencyVersions (dependency, declarations, nodeVersion, packageVersions) {
  const { versionList, unversioned: supportedRange } = resolvePluginVersions({
    name: dependency,
    declarations,
    nodeVersion,
    env: {},
  })
  const testedVersions = new Set()

  for (const { versionKey } of versionList) {
    const range = getCappedRange(dependency, versionKey)
    const version = semver.maxSatisfying(packageVersions, range)
    if (!version) throw new Error(`Could not resolve '${dependency}@${range}' from npm metadata`)
    if (!brokenVersionReason(dependency, version)) testedVersions.add(version)
  }

  return {
    supportedRange: supportedRange === undefined ? undefined : simplifySupportedRange(supportedRange),
    tested: [...testedVersions].sort(semver.compare),
  }
}

/**
 * @param {Map<string, string>} plugins
 * @param {NodeProfile[]} nodeProfiles
 * @param {Map<string, Map<string, InstrumentationDeclaration[]>>} instrumentations
 * @param {(dependency: string) => Promise<string[]>} getPackageVersions
 * @returns {Promise<object[]>}
 */
async function buildRows (plugins, nodeProfiles, instrumentations, getPackageVersions) {
  const dependencies = new Set()
  for (const [dependency] of plugins) {
    if (isBuiltin(dependency)) continue
    for (const { version } of nodeProfiles) {
      if (instrumentations.get(version)?.has(dependency)) {
        dependencies.add(dependency)
        break
      }
    }
  }

  const availableVersions = new Map()
  await mapWithConcurrency([...dependencies], FETCH_CONCURRENCY, async dependency => {
    availableVersions.set(dependency, await getPackageVersions(dependency))
  })

  const rows = []
  for (const [dependency, integration] of plugins) {
    const builtin = isBuiltin(dependency)
    const versionsBySupport = new Map()

    for (const { version: nodeVersion } of nodeProfiles) {
      let supportedRange = '*'
      let tested = []

      if (!builtin) {
        const declarations = instrumentations.get(nodeVersion)?.get(dependency)
        if (!declarations) continue
        const resolved = resolveDependencyVersions(
          dependency,
          declarations,
          nodeVersion,
          availableVersions.get(dependency)
        )
        if (resolved.tested.length === 0) continue
        supportedRange = resolved.supportedRange
        tested = resolved.tested
      }

      const supportKey = JSON.stringify([supportedRange, tested])
      let versionSupport = versionsBySupport.get(supportKey)
      if (!versionSupport) {
        versionSupport = {
          testedRuntimes: { node: [] },
          supportedRange,
          tested,
        }
        versionsBySupport.set(supportKey, versionSupport)
      }
      versionSupport.testedRuntimes.node.push(nodeVersion)
    }

    if (versionsBySupport.size > 0) {
      const versions = [...versionsBySupport.values()]
      for (const versionSupport of versions) {
        versionSupport.testedRuntimes.node.sort(semver.rcompare)
      }
      versions.sort((left, right) =>
        semver.rcompare(left.testedRuntimes.node[0], right.testedRuntimes.node[0])
      )

      rows.push({
        dependencyName: normalizeDependency(dependency),
        integrationName: integration,
        autoInstrumented: true,
        versions,
      })
    }
  }

  return rows.sort((left, right) =>
    left.integrationName.localeCompare(right.integrationName) ||
    left.dependencyName.localeCompare(right.dependencyName)
  )
}

/**
 * @param {GenerationOptions} [options]
 * @returns {Promise<{ rows: object[], json: string }>}
 */
async function generateSupportedIntegrations (options = {}) {
  const packageInfo = options.packageInfo ?? JSON.parse(readFileSync(ROOT_PACKAGE, 'utf8'))
  const versions = options.versions ??
    JSON.parse(readFileSync(VERSIONS_PACKAGE, 'utf8')).dependencies
  const nodeProfiles = options.nodeProfiles ?? readNodeProfiles(packageInfo, versions, options.nodeRange ?? '*')
  const plugins = options.plugins ?? readPluginMap()
  const instrumentations = options.instrumentations ?? readInstrumentations(nodeProfiles)
  const rows = await buildRows(
    plugins,
    nodeProfiles,
    instrumentations,
    options.getPackageVersions ?? fetchPackageVersions
  )

  return {
    rows,
    json: JSON.stringify(rows, null, 4) + '\n',
  }
}

/**
 * @param {GenerationOptions} [options]
 * @returns {Promise<void>}
 */
async function writeSupportedIntegrations (options = {}) {
  const { json } = await generateSupportedIntegrations(options)
  writeFileSync(options.outputPath ?? JSON_OUTPUT_PATH, json)
}

/**
 * @param {string} file
 * @param {string} expected
 * @returns {boolean}
 */
function reportDrift (file, expected) {
  if (readFileSync(file, 'utf8').replaceAll('\r\n', '\n') === expected) return false
  // eslint-disable-next-line no-console
  console.error(`Out of date: ${path.relative(ROOT, file)}`)
  return true
}

/**
 * @param {GenerationOptions} [options]
 * @returns {Promise<boolean>}
 */
async function checkSupportedIntegrations (options = {}) {
  const { json } = await generateSupportedIntegrations(options)
  if (!reportDrift(options.outputPath ?? JSON_OUTPUT_PATH, json)) return true
  // eslint-disable-next-line no-console
  console.error('\nRun: npm run generate:supported-integrations')
  return false
}

/**
 * @param {string[]} args
 * @returns {string}
 */
function readNodeRange (args) {
  const index = args.indexOf(NODE_RANGE_FLAG)
  if (index === -1) return '*'
  const range = args[index + 1]
  if (!range || range.startsWith('--')) throw new Error(`${NODE_RANGE_FLAG} requires a semver range`)
  return range
}

/** @returns {Promise<void>} */
async function main () {
  const options = { nodeRange: readNodeRange(process.argv.slice(2)) }
  if (process.argv.includes(CHECK_FLAG)) {
    process.exitCode = Number(!await checkSupportedIntegrations(options))
  } else {
    await writeSupportedIntegrations(options)
  }
}

if (require.main === module) {
  main().catch(error => {
    // eslint-disable-next-line no-console
    console.error(error)
    process.exitCode = 1
  })
}

module.exports = {
  JSON_OUTPUT_PATH,
  checkSupportedIntegrations,
  generateSupportedIntegrations,
  writeSupportedIntegrations,
}
