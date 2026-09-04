'use strict'

const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')

const { createBuildPlan } = require('./src/targets')

const loader = require.resolve('./src/loader')
const PHASE_PRODUCTION_SERVER = 'phase-production-server'
const SOURCE_EXTENSIONS = ['*.js', '*.cjs', '*.mjs', '*.jsx', '*.ts', '*.cts', '*.mts', '*.tsx']
const SOURCE_PATH_PATTERN = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/

/**
 * Adds Datadog instrumentation to a Next.js configuration.
 *
 * @param {object|Promise<object>|Function} [nextConfig]
 * @param {{ projectDir?: string }} [options]
 * @returns {Function}
 */
function withDatadogTurbopack (nextConfig = {}, options = {}) {
  if (!isObject(options)) {
    throw new TypeError('withDatadogTurbopack options must be an object')
  }
  if (options.projectDir !== undefined && typeof options.projectDir !== 'string') {
    throw new TypeError('withDatadogTurbopack options.projectDir must be a string')
  }

  const projectDir = path.resolve(options.projectDir ?? process.cwd())
  const nextInfo = getNextInfo(projectDir)

  return async function datadogNextConfig (...args) {
    const config = typeof nextConfig === 'function'
      ? await nextConfig.apply(this, args)
      : await nextConfig
    const normalized = normalizeConfig(config)
    if (args[0] === PHASE_PRODUCTION_SERVER) return normalized

    return addDatadogConfig(normalized, projectDir, nextInfo)
  }
}

/**
 * @param {object} nextConfig
 * @param {string} projectDir
 * @param {{ compiler: { generator: string, parser: string, traverse: string }, major: number, root: string }} nextInfo
 * @returns {Promise<object>}
 */
async function addDatadogConfig (nextConfig, projectDir, nextInfo) {
  const turbopack = nextConfig.turbopack ?? {}
  let discoveryRoot = nextInfo.root
  if (typeof turbopack.root === 'string') discoveryRoot = turbopack.root
  if (typeof nextConfig.outputFileTracingRoot === 'string') discoveryRoot = nextConfig.outputFileTracingRoot
  const plan = await createBuildPlan(projectDir, {
    compiler: nextInfo.compiler,
    discoveryRoot,
  })
  if (!plan.targetPathPattern || !plan.path) return nextConfig

  const configured = nextInfo.major === 15
    ? addLegacyRules(turbopack, plan)
    : addModernRules(turbopack, plan)

  return {
    ...nextConfig,
    turbopack: configured,
  }
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

  const { turbopack } = config
  if (turbopack !== undefined && !isObject(turbopack)) {
    throw new TypeError('nextConfig.turbopack must be an object')
  }
  if (turbopack?.rules !== undefined && !isObject(turbopack.rules)) {
    throw new TypeError('nextConfig.turbopack.rules must be an object')
  }
  if (turbopack?.conditions !== undefined && !isObject(turbopack.conditions)) {
    throw new TypeError('nextConfig.turbopack.conditions must be an object')
  }
  if (turbopack?.resolveAlias !== undefined && !isObject(turbopack.resolveAlias)) {
    throw new TypeError('nextConfig.turbopack.resolveAlias must be an object')
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
 * @param {object} plan
 * @returns {object}
 */
function addModernRules (turbopack, plan) {
  const rules = { ...turbopack.rules }

  for (const extension of SOURCE_EXTENSIONS) {
    const existing = rules[extension]
    if (hasDatadogLoader(existing)) continue

    const additions = [createModernRule(
      plan,
      [{ path: plan.targetPathPattern }],
      { rewriteEdges: true, targetScope: 'direct' }
    )]
    if (plan.moduleSyntaxPattern) {
      additions.push(createModernRule(
        plan,
        [{ not: 'foreign' }, { content: plan.moduleSyntaxPattern }],
        { rewriteEdges: true }
      ))
    }
    if (plan.foreignModuleSyntaxPattern) {
      additions.push(createModernRule(
        plan,
        ['foreign', { content: plan.foreignModuleSyntaxPattern }],
        { rewriteEdges: true }
      ))
    }
    if (plan.relativePathPattern) {
      additions.push(createModernRule(
        plan,
        [{ not: 'foreign' }, { path: plan.relativePathPattern }],
        { targetScope: 'relative' }
      ))
    }
    if (existing === undefined) {
      rules[extension] = additions.length === 1 ? additions[0] : additions
    } else {
      rules[extension] = Array.isArray(existing) ? [...existing, ...additions] : [existing, ...additions]
    }
  }

  return { ...turbopack, rules }
}

/**
 * @param {object} turbopack
 * @param {object} plan
 * @returns {object}
 */
function addLegacyRules (turbopack, plan) {
  const conditions = { ...turbopack.conditions }
  const rules = { ...turbopack.rules }

  addLegacyRule(
    conditions,
    rules,
    '#dd-trace/target',
    { path: plan.targetPathPattern },
    { node: { loaders: [createLoader(plan, { rewriteEdges: true, targetScope: 'direct' })] } }
  )

  if (plan.moduleSyntaxPattern) {
    addLegacyRule(
      conditions,
      rules,
      '#dd-trace/import',
      { content: plan.moduleSyntaxPattern, path: SOURCE_PATH_PATTERN },
      {
        node: {
          default: { loaders: [createLoader(plan, { rewriteEdges: true })] },
          foreign: false,
        },
      }
    )
  }

  if (plan.foreignModuleSyntaxPattern) {
    addLegacyRule(
      conditions,
      rules,
      '#dd-trace/foreign-import',
      { content: plan.foreignModuleSyntaxPattern, path: SOURCE_PATH_PATTERN },
      { node: { foreign: { loaders: [createLoader(plan, { rewriteEdges: true })] } } }
    )
  }

  if (plan.relativePathPattern) {
    addLegacyRule(
      conditions,
      rules,
      '#dd-trace/relative',
      { path: plan.relativePathPattern },
      {
        node: {
          default: { loaders: [createLoader(plan, { targetScope: 'relative' })] },
          foreign: false,
        },
      }
    )
  }

  return { ...turbopack, conditions, rules }
}

/**
 * @param {Record<string, object>} conditions
 * @param {Record<string, object>} rules
 * @param {string} name
 * @param {object} condition
 * @param {object} rule
 */
function addLegacyRule (conditions, rules, name, condition, rule) {
  if (hasDatadogLoader(rules[name])) return
  if (Object.hasOwn(conditions, name) || Object.hasOwn(rules, name)) {
    throw new Error(`Next.js Turbopack configuration already uses the reserved condition ${name}`)
  }
  conditions[name] = condition
  rules[name] = rule
}

/**
 * @param {object} plan
 * @param {(object|string)[]} conditions
 * @param {object} settings
 * @returns {object}
 */
function createModernRule (plan, conditions, settings) {
  return {
    condition: { all: ['node', ...conditions] },
    loaders: [createLoader(plan, settings)],
  }
}

/**
 * @param {object} plan
 * @param {{
 *   rewriteEdges?: boolean,
 *   targetScope?: 'direct'|'relative'
 * }} [settings]
 * @returns {object}
 */
function createLoader (plan, settings = {}) {
  const options = { manifestPath: plan.path }
  if (settings.rewriteEdges) options.rewriteEdges = true
  if (settings.targetScope) options.targetScope = settings.targetScope
  return { loader, options }
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function hasDatadogLoader (value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (hasDatadogLoader(item)) return true
    }
    return false
  }
  if (!value || typeof value !== 'object') return false
  const candidate = /** @type {{ loader?: unknown }} */ (value)
  if (candidate.loader === loader) return true

  for (const key of Object.keys(value)) {
    if (hasDatadogLoader(value[key])) return true
  }
  return false
}

/**
 * @param {string} projectDir
 * @returns {{ compiler: { generator: string, parser: string, traverse: string }, major: number, root: string }}
 */
function getNextInfo (projectDir) {
  let version
  let appRequire
  try {
    appRequire = Module.createRequire(path.join(projectDir, 'package.json'))
    const packagePath = appRequire.resolve('next/package.json')
    version = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version
  } catch (error) {
    throw new Error(`withDatadogTurbopack could not resolve Next.js from ${projectDir}`, { cause: error })
  }

  const match = /^(\d+)\.(\d+)\./.exec(version)
  if (!match) throw new Error(`withDatadogTurbopack could not parse Next.js version ${version}`)
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major < 15 || (major === 15 && minor < 5)) {
    throw new RangeError(`withDatadogTurbopack requires Next.js 15.5 or newer; found ${version}`)
  }

  try {
    const rootFinder = appRequire('next/dist/lib/find-root')
    const root = typeof rootFinder.findRootDirAndLockFiles === 'function'
      ? rootFinder.findRootDirAndLockFiles(projectDir).rootDir
      : rootFinder.findRootDir(projectDir) ?? projectDir

    return {
      compiler: {
        generator: appRequire.resolve('next/dist/compiled/babel/generator'),
        parser: appRequire.resolve('next/dist/compiled/babel/parser'),
        traverse: appRequire.resolve('next/dist/compiled/babel/traverse'),
      },
      major,
      root,
    }
  } catch (error) {
    throw new Error(`Next.js ${version} does not provide the compiler required by withDatadogTurbopack`, {
      cause: error,
    })
  }
}

module.exports = {
  withDatadogTurbopack,
}
