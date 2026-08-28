'use strict'

const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')

const { createBuildPlan } = require('./src/targets')

const loader = require.resolve('./src/loader')
const SOURCE_EXTENSIONS = ['*.js', '*.cjs', '*.mjs', '*.jsx', '*.ts', '*.cts', '*.mts', '*.tsx']
const SOURCE_PATH_PATTERN = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/

/**
 * Adds Datadog instrumentation to a Next.js configuration.
 *
 * @param {object|Promise<object>|Function} [nextConfig]
 * @param {{ projectDir?: string }} [options]
 * @returns {Promise<object>|Function}
 */
function withDatadogTurbopack (nextConfig = {}, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('withDatadogTurbopack options must be an object')
  }
  if (options.projectDir !== undefined && typeof options.projectDir !== 'string') {
    throw new TypeError('withDatadogTurbopack options.projectDir must be a string')
  }

  const projectDir = path.resolve(options.projectDir ?? process.cwd())
  const nextInfo = getNextInfo(projectDir)
  if (typeof nextConfig === 'function') {
    return async function datadogNextConfig (...args) {
      const config = await nextConfig.apply(this, args)
      return addDatadogConfig(normalizeConfig(config), projectDir, nextInfo)
    }
  }

  return Promise.resolve(nextConfig).then(config =>
    addDatadogConfig(normalizeConfig(config), projectDir, nextInfo)
  )
}

/**
 * @param {object} nextConfig
 * @param {string} projectDir
 * @param {{ compiler: { generator: string, parser: string, traverse: string }, major: number }} nextInfo
 * @returns {Promise<object>}
 */
async function addDatadogConfig (nextConfig, projectDir, nextInfo) {
  const plan = await createBuildPlan(projectDir)
  if (!plan.packagePathPattern || !plan.targetPathPattern || !plan.path || !plan.hash) return nextConfig

  const turbopack = nextConfig.turbopack ?? {}
  const configured = nextInfo.major === 15
    ? addLegacyRules(turbopack, plan, nextInfo.compiler)
    : addModernRules(turbopack, plan, nextInfo.compiler)

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
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('withDatadogTurbopack expects a Next.js configuration object, promise, or function')
  }

  const { turbopack } = config
  if (turbopack !== undefined && (!turbopack || typeof turbopack !== 'object' || Array.isArray(turbopack))) {
    throw new TypeError('nextConfig.turbopack must be an object')
  }
  if (turbopack?.rules !== undefined &&
    (!turbopack.rules || typeof turbopack.rules !== 'object' || Array.isArray(turbopack.rules))) {
    throw new TypeError('nextConfig.turbopack.rules must be an object')
  }
  if (turbopack?.conditions !== undefined &&
    (!turbopack.conditions || typeof turbopack.conditions !== 'object' || Array.isArray(turbopack.conditions))) {
    throw new TypeError('nextConfig.turbopack.conditions must be an object')
  }
  if (turbopack?.resolveAlias !== undefined &&
    (!turbopack.resolveAlias || typeof turbopack.resolveAlias !== 'object' || Array.isArray(turbopack.resolveAlias))) {
    throw new TypeError('nextConfig.turbopack.resolveAlias must be an object')
  }

  return config
}

/**
 * @param {object} turbopack
 * @param {object} plan
 * @param {{ generator: string, parser: string, traverse: string }} compiler
 * @returns {object}
 */
function addModernRules (turbopack, plan, compiler) {
  const rules = { ...turbopack.rules }

  for (const extension of SOURCE_EXTENSIONS) {
    const existing = rules[extension]
    if (hasDatadogLoader(existing)) continue

    const additions = [createModernTargetRule(plan, compiler)]
    if (plan.moduleSyntaxPattern) additions.push(createModernImportRule(plan, compiler))
    if (plan.relativePathPattern) additions.push(createModernRelativeRule(plan))

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
 * @param {{ generator: string, parser: string, traverse: string }} compiler
 * @returns {object}
 */
function addLegacyRules (turbopack, plan, compiler) {
  const conditions = { ...turbopack.conditions }
  const rules = { ...turbopack.rules }

  addLegacyRule(
    conditions,
    rules,
    '#dd-trace/target',
    {
      path: new RegExp(
        `(?:${plan.packagePathPattern.source}.*${SOURCE_PATH_PATTERN.source}|${plan.targetPathPattern.source})`
      ),
    },
    { node: { loaders: [createLoader(plan, { compiler, rewriteEdges: true, targetScope: 'direct' })] } }
  )

  if (plan.moduleSyntaxPattern) {
    addLegacyRule(
      conditions,
      rules,
      '#dd-trace/import',
      { content: plan.moduleSyntaxPattern, path: SOURCE_PATH_PATTERN },
      { node: { foreign: false, loaders: [createLoader(plan, { compiler, rewriteEdges: true })] } }
    )
  }

  if (plan.relativePathPattern) {
    addLegacyRule(
      conditions,
      rules,
      '#dd-trace/relative',
      { path: plan.relativePathPattern },
      { node: { foreign: false, loaders: [createLoader(plan, { targetScope: 'relative' })] } }
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
 * @param {{ generator: string, parser: string, traverse: string }} compiler
 * @returns {object}
 */
function createModernTargetRule (plan, compiler) {
  return {
    condition: {
      all: ['node', {
        any: [
          { path: plan.packagePathPattern },
          { path: plan.targetPathPattern },
        ],
      }],
    },
    loaders: [createLoader(plan, { compiler, rewriteEdges: true, targetScope: 'direct' })],
  }
}

/**
 * @param {object} plan
 * @param {{ generator: string, parser: string, traverse: string }} compiler
 * @returns {object}
 */
function createModernImportRule (plan, compiler) {
  return {
    condition: { all: ['node', { not: 'foreign' }, { content: plan.moduleSyntaxPattern }] },
    loaders: [createLoader(plan, { compiler, rewriteEdges: true })],
  }
}

/**
 * @param {object} plan
 * @returns {object}
 */
function createModernRelativeRule (plan) {
  return {
    condition: { all: ['node', { not: 'foreign' }, { path: plan.relativePathPattern }] },
    loaders: [createLoader(plan, { targetScope: 'relative' })],
  }
}

/**
 * @param {object} plan
 * @param {{
 *   compiler?: { generator: string, parser: string, traverse: string },
 *   rewriteEdges?: boolean,
 *   targetScope?: 'direct'|'relative'
 * }} [settings]
 * @returns {object}
 */
function createLoader (plan, settings = {}) {
  const options = {
    manifestHash: plan.hash,
    manifestPath: plan.path,
  }
  if (settings.compiler) options.compiler = settings.compiler
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
  if (value.loader === loader) return true

  for (const key of Object.keys(value)) {
    if (hasDatadogLoader(value[key])) return true
  }
  return false
}

/**
 * @param {string} projectDir
 * @returns {{ compiler: { generator: string, parser: string, traverse: string }, major: number }}
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
    return {
      compiler: {
        generator: appRequire.resolve('next/dist/compiled/babel/generator'),
        parser: appRequire.resolve('next/dist/compiled/babel/parser'),
        traverse: appRequire.resolve('next/dist/compiled/babel/traverse'),
      },
      major,
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
