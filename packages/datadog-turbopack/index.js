'use strict'

const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')

const satisfies = require('../../vendor/dist/semifies')
const hooks = require('../datadog-instrumentations/src/helpers/hooks')
const { SYNTHETIC_EXTENSION } = require('./src/constants')

const BUILTIN_MODULES = new Set(Module.builtinModules)
const loader = path.join(__dirname, 'src/loader.js')
const EXTENSIONLESS_PATH_PATTERN = /(?:^|\/)[^/.]+$/
const PHASE_PRODUCTION_SERVER = 'phase-production-server'
const SOURCE_EXTENSIONS = ['*.js', '*.cjs', '*.mjs', '*.jsx', '*.ts', '*.cts', '*.mts', '*.tsx']
const SOURCE_PATH_PATTERN = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/
const PACKAGE_PATH_PATTERN = createPackagePathPattern()

/**
 * Adds Datadog instrumentation to a Next.js Turbopack configuration.
 *
 * @param {object|Promise<object>|Function} [nextConfig]
 * @returns {Function}
 */
function withDatadogTurbopack (nextConfig = {}) {
  const nextMajor = getNextMajor()

  return function datadogNextConfig (...args) {
    const config = typeof nextConfig === 'function'
      ? nextConfig.apply(this, args)
      : nextConfig
    if (config && typeof config.then === 'function') {
      return config.then(config => configureTurbopack(config, args[0], nextMajor))
    }
    return configureTurbopack(config, args[0], nextMajor)
  }
}

/**
 * @param {object|undefined} config
 * @param {unknown} phase
 * @param {number} nextMajor
 * @returns {object}
 */
function configureTurbopack (config, phase, nextMajor) {
  const normalized = normalizeConfig(config)
  if (phase === PHASE_PRODUCTION_SERVER || hasDatadogLoader(normalized.turbopack?.rules)) return normalized

  const turbopack = normalized.turbopack ?? {}
  const configured = nextMajor === 15 ? addLegacyRule(turbopack) : addModernRules(turbopack)
  return { ...normalized, turbopack: configured }
}

/**
 * @param {object|undefined} config
 * @returns {object}
 */
function normalizeConfig (config) {
  if (config === undefined) return {}
  if (!isObject(config)) {
    throw new TypeError('withDatadogTurbopack expects a Next.js configuration object, promise, or function')
  }
  if (config.turbopack !== undefined && !isObject(config.turbopack)) {
    throw new TypeError('nextConfig.turbopack must be an object')
  }
  if (config.turbopack?.rules !== undefined && !isObject(config.turbopack.rules)) {
    throw new TypeError('nextConfig.turbopack.rules must be an object')
  }
  if (config.turbopack?.conditions !== undefined && !isObject(config.turbopack.conditions)) {
    throw new TypeError('nextConfig.turbopack.conditions must be an object')
  }
  return config
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isObject (value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {object} turbopack
 * @returns {object}
 */
function addModernRules (turbopack) {
  const rules = { ...turbopack.rules }
  for (const extension of SOURCE_EXTENSIONS) {
    appendRule(rules, extension, {
      condition: { all: ['node', 'foreign', { path: PACKAGE_PATH_PATTERN }] },
      loaders: [createLoader()],
    })
  }
  appendRule(rules, '*', {
    as: `*${SYNTHETIC_EXTENSION}`,
    condition: {
      all: ['node', 'foreign', { path: PACKAGE_PATH_PATTERN }, { path: EXTENSIONLESS_PATH_PATTERN }],
    },
    loaders: [createLoader()],
  })
  return { ...turbopack, rules }
}

/**
 * @param {Record<string, object|object[]>} rules
 * @param {string} extension
 * @param {object} rule
 */
function appendRule (rules, extension, rule) {
  const existing = rules[extension]
  if (existing === undefined) {
    rules[extension] = rule
  } else {
    rules[extension] = Array.isArray(existing) ? [...existing, rule] : [existing, rule]
  }
}

/**
 * @param {object} turbopack
 * @returns {object}
 */
function addLegacyRule (turbopack) {
  const name = '#dd-trace/modules'
  const conditions = { ...turbopack.conditions }
  const rules = { ...turbopack.rules }
  if (Object.hasOwn(conditions, name) || Object.hasOwn(rules, name)) {
    throw new Error(`Next.js Turbopack configuration already uses the reserved condition ${name}`)
  }
  conditions[name] = {
    all: [
      { path: PACKAGE_PATH_PATTERN },
      { any: [{ path: SOURCE_PATH_PATTERN }, { path: EXTENSIONLESS_PATH_PATTERN }] },
    ],
  }
  rules[name] = { node: { foreign: { loaders: [createLoader()] } } }
  return { ...turbopack, conditions, rules }
}

/**
 * @returns {{ loader: string, options: object }}
 */
function createLoader () {
  return { loader, options: {} }
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function hasDatadogLoader (value) {
  if (Array.isArray(value)) return value.some(hasDatadogLoader)
  if (!value || typeof value !== 'object') return false
  if (/** @type {{ loader?: unknown }} */ (value).loader === loader) return true
  return Object.values(value).some(hasDatadogLoader)
}

/**
 * @returns {RegExp}
 */
function createPackagePathPattern () {
  const names = []
  for (const name of Object.keys(hooks)) {
    if (!name.startsWith('.') && !BUILTIN_MODULES.has(name)) names.push(escapeRegExp(name))
  }
  names.sort()
  return new RegExp(`(?:^|/)(?:${names.join('|')})(?:/|$)`)
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp (value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

/**
 * @returns {number}
 */
function getNextMajor () {
  const entrypoints = []
  if (require.main?.filename) entrypoints.push(require.main.filename)
  entrypoints.push(path.join(process.cwd(), 'package.json'))

  let version
  let resolutionError
  for (const entrypoint of entrypoints) {
    try {
      const appRequire = Module.createRequire(entrypoint)
      version = JSON.parse(fs.readFileSync(appRequire.resolve('next/package.json'), 'utf8')).version
      break
    } catch (error) {
      resolutionError = error
    }
  }
  if (!version) {
    throw new Error('withDatadogTurbopack could not resolve the active Next.js installation', {
      cause: resolutionError,
    })
  }

  if (!satisfies(version, '>=0')) {
    throw new Error(`withDatadogTurbopack could not parse Next.js version ${version}`)
  }
  if (!satisfies(version, '>=15.5.0')) {
    throw new RangeError(`withDatadogTurbopack requires Next.js 15.5 or newer; found ${version}`)
  }
  return Number.parseInt(version, 10)
}

module.exports = { withDatadogTurbopack }
