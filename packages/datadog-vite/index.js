'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { instrument, packagePathPattern } = require('../datadog-instrumentations/src/helpers/bundler-transform')
const { getGitMetadataBanner } = require('../datadog-instrumentations/src/helpers/bundler-utils')
const { getValueFromEnvSources } = require('../dd-trace/src/config/helper')
const log = require('./src/log')

const PLUGIN_NAME = 'datadog-vite'
const NODE_MODULES = '/node_modules/'
const TRACER_DIRECTORY = `${fs.realpathSync(path.join(__dirname, '..', '..')).replaceAll('\\', '/')}/`
// Optional dependencies of the tracer, required lazily. They must stay out of the bundle: some are native addons and
// any of them may be missing at runtime.
const OPTIONAL_DEPENDENCY_PATTERN =
  /^(?:@datadog\/(?:libdatadog(?:-extras)?|native-appsec|native-iast-taint-tracking|native-metrics|pprof|wasm-js-rewriter)|@opentelemetry\/api(?:-logs)?|oxc-parser)(?:\/|$)/
const mergedFunctions = new WeakSet()

/**
 * @typedef {string | RegExp | Array<string | RegExp> |
 *   ((id: string, parentId: string | undefined, isResolved: boolean) => unknown)} External
 * @typedef {{ keepNames?: boolean }} OutputOptions
 * @typedef {{ external?: External, output?: OutputOptions | OutputOptions[] }} BundlerOptions
 * @typedef {{
 *   commonjsOptions?: { ignore?: string[] | ((id: string) => boolean) },
 *   lib?: unknown,
 *   minify?: boolean | string,
 *   rolldownOptions?: BundlerOptions,
 *   rollupOptions?: BundlerOptions,
 *   ssr?: boolean | string,
 *   terserOptions?: { keep_classnames?: unknown, keep_fnames?: unknown },
 * }} BuildOptions
 * @typedef {{ build?: BuildOptions, consumer?: string }} UserConfig
 * @typedef {{
 *   build: BuildOptions,
 *   builder?: { sharedConfigBuild?: boolean },
 *   environments: Record<string, { build: BuildOptions, consumer: string } | undefined>,
 *   esbuild: false | { keepNames?: boolean },
 * }} ResolvedConfig
 * @typedef {{ meta?: { rolldownVersion?: string } } | undefined} HookContext
 * @typedef {{ warn: (message: string) => void }} TransformContext
 * @typedef {{ name: string, config: { build: BuildOptions, consumer: string } }} Environment
 */

/**
 * Creates the Datadog plugin for Vite builds producing Node.js code.
 */
function datadogVite () {
  const injectGitMetadata = getValueFromEnvSources('DD_BUNDLER_INJECT_GIT_METADATA') !== false
  const skippedEnvironments = new Set()
  /** @type {string|undefined} */
  let gitIntro

  if (!injectGitMetadata) log.debug('Skipping git metadata injection (DD_BUNDLER_INJECT_GIT_METADATA=false)')

  return {
    name: PLUGIN_NAME,
    apply: 'build',
    enforce: 'pre',

    /**
     * Rollup-based Vite has no per-environment esbuild options. They are read when chunks are rendered, so they can
     * still change once the configuration is resolved.
     *
     * @this {HookContext}
     * @param {ResolvedConfig} config
     */
    configResolved (config) {
      // Older versions lack the Environment API hooks, so the build would silently miss required configuration.
      if (!config.environments) throw new Error('dd-trace/vite requires Vite 6 or newer. Refusing to bundle.')
      if (isRolldown(this) || !config.esbuild || !needsEsbuildKeepNames(config)) return
      config.esbuild.keepNames = true
      log.debug('Enabled esbuild keepNames so minification preserves function and class names')
    },

    /**
     * @this {HookContext}
     * @param {string} name
     * @param {UserConfig} config
     */
    configEnvironment (name, config) {
      const consumer = config.consumer ?? (name === 'client' ? 'client' : 'server')
      if (!isNodeBuild(consumer, config.build)) return
      config.build ??= {}
      configureBuild(name, config.build, consumer, isRolldown(this))
    },

    /**
     * @param {Environment} environment
     */
    applyToEnvironment (environment) {
      const { build, consumer } = environment.config
      if (isNodeBuild(consumer, build)) return true
      if (!skippedEnvironments.has(environment.name)) {
        skippedEnvironments.add(environment.name)
        log.debug('Skipping the %s environment: it does not build Node.js code', environment.name)
      }
      return false
    },

    transform: {
      // Vite versions without hook filters call the handler for every module, which checks the id again.
      filter: { id: packagePathPattern },
      /**
       * @this {TransformContext}
       * @param {string} code
       * @param {string} id
       */
      handler (code, id) {
        return transform(this, code, id)
      },
    },

    /**
     * Runs before the chunk's own code: in CommonJS output after the strict-mode directive and before the hoisted
     * `require` calls, unlike a banner, which would precede the directive.
     *
     * @param {{ isEntry: boolean }} chunk
     */
    intro (chunk) {
      if (!injectGitMetadata || !chunk.isEntry) return ''
      gitIntro ??= getGitMetadataBanner(log)
      return gitIntro
    },
  }
}

/**
 * @param {TransformContext} context
 * @param {string} code
 * @param {string} id
 * @returns {{ code: string, map: string | object | null } | undefined}
 */
function transform (context, code, id) {
  let output
  if (!isInstrumentable(id)) return output
  try {
    const result = instrument({ source: code, resourcePath: id, warn: warning => context.warn(warning.message) })
    if (result && result.code !== code) output = { code: result.code, map: result.map ?? null }
  } catch (error) {
    context.warn(`Skipped ${id}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return output
}

/**
 * @param {string} id
 */
function isInstrumentable (id) {
  return id.charCodeAt(0) !== 0 && !id.includes('?') && id.includes(NODE_MODULES) &&
    !id.startsWith(TRACER_DIRECTORY) && packagePathPattern.test(id)
}

/**
 * @param {HookContext} context
 */
function isRolldown (context) {
  return Boolean(context?.meta?.rolldownVersion)
}

/**
 * Electron preload, renderer and other client builds are never instrumented.
 *
 * @param {string | undefined} consumer
 * @param {BuildOptions} [build]
 */
function isNodeBuild (consumer, build) {
  return consumer === 'server' || Boolean(build?.ssr) || Boolean(build?.lib)
}

/**
 * Whether a built environment producing Node.js code minifies with esbuild. A builder sharing the configuration
 * shares the esbuild options too, so client environments built alongside such an environment keep names as well.
 *
 * @param {ResolvedConfig} config
 */
function needsEsbuildKeepNames (config) {
  if (config.esbuild && config.esbuild.keepNames !== undefined) return false
  // Each environment resolves its own configuration, whose build options are the environment's.
  if (!config.builder?.sharedConfigBuild) return isMinifiedByEsbuild(undefined, config.build)
  return Object.values(config.environments).some(environment =>
    environment && isMinifiedByEsbuild(environment.consumer, environment.build))
}

/**
 * @param {string | undefined} consumer
 * @param {BuildOptions} build
 */
function isMinifiedByEsbuild (consumer, build) {
  return isNodeBuild(consumer, build) && build.minify === 'esbuild'
}

/**
 * @param {string} name
 * @param {BuildOptions} build
 * @param {string} consumer
 * @param {boolean} rolldown
 */
function configureBuild (name, build, consumer, rolldown) {
  const minify = getMinify(build.minify, consumer, rolldown)
  if (rolldown) {
    // Vite 8 aliases `rollupOptions` to `rolldownOptions`; reuse whichever object the configuration already has.
    const options = build.rolldownOptions ?? build.rollupOptions ?? (build.rolldownOptions = {})
    options.external = mergeExternal(options.external)
    if (minify) enableOutputKeepNames(name, options)
  } else {
    // Rollup hoists external `require` calls to the top of the chunk, which would load optional dependencies eagerly
    // and crash when they are missing. Ignored `require` calls stay where they are.
    const commonjsOptions = build.commonjsOptions ??= {}
    commonjsOptions.ignore = mergeIgnore(commonjsOptions.ignore)
  }
  if (minify === 'terser') {
    const terserOptions = build.terserOptions ??= {}
    terserOptions.keep_classnames ??= true
    terserOptions.keep_fnames ??= true
    log.debug('Enabled terser keep_classnames and keep_fnames for the %s environment', name)
  }
}

/**
 * Mirrors Vite's defaults: server environments are not minified.
 *
 * @param {unknown} minify
 * @param {string} consumer
 * @param {boolean} rolldown
 */
function getMinify (minify, consumer, rolldown) {
  const defaultMinifier = rolldown ? 'oxc' : 'esbuild'
  if (minify === undefined) return consumer === 'server' ? false : defaultMinifier
  if (minify === false || minify === 'false') return false
  return minify === true ? defaultMinifier : minify
}

/**
 * @param {string} name
 * @param {BundlerOptions} options
 */
function enableOutputKeepNames (name, options) {
  options.output ??= {}
  for (const output of Array.isArray(options.output) ? options.output : [options.output]) {
    if (output.keepNames !== undefined) continue
    output.keepNames = true
    log.debug('Enabled output keepNames for the %s environment', name)
  }
}

/**
 * @param {External} [external]
 * @returns {External}
 */
function mergeExternal (external) {
  if (external === undefined || external === null) return [OPTIONAL_DEPENDENCY_PATTERN]
  if (typeof external === 'function') {
    if (mergedFunctions.has(external)) return external
    /** @type {External} */
    const merged = (id, parentId, isResolved) =>
      OPTIONAL_DEPENDENCY_PATTERN.test(id) || external(id, parentId, isResolved)
    mergedFunctions.add(merged)
    return merged
  }
  const externals = Array.isArray(external) ? external : [external]
  if (externals.some(entry => typeof entry === 'function')) return mergeExternal(matchAny(externals))
  return externals.includes(OPTIONAL_DEPENDENCY_PATTERN) ? externals : [...externals, OPTIONAL_DEPENDENCY_PATTERN]
}

/**
 * Vite concatenates arrays when merging configurations, so a function returned by one plugin or the user can end up
 * in an array, which the bundler rejects.
 *
 * @param {Array<string | RegExp | Function>} externals
 * @returns {External}
 */
function matchAny (externals) {
  return (id, parentId, isResolved) => externals.some(entry => {
    if (typeof entry === 'function') return entry(id, parentId, isResolved)
    return typeof entry === 'string' ? entry === id : entry.test(id)
  })
}

/**
 * @param {string[] | ((id: string) => boolean)} [ignore]
 * @returns {(id: string) => boolean}
 */
function mergeIgnore (ignore) {
  if (typeof ignore === 'function' && mergedFunctions.has(ignore)) return ignore
  let merged
  if (typeof ignore === 'function') {
    merged = (/** @type {string} */ id) => OPTIONAL_DEPENDENCY_PATTERN.test(id) || ignore(id)
  } else {
    const ids = new Set(ignore)
    merged = (/** @type {string} */ id) => OPTIONAL_DEPENDENCY_PATTERN.test(id) || ids.has(id)
  }
  mergedFunctions.add(merged)
  return merged
}

module.exports = { datadogVite }
