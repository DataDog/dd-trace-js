'use strict'

const fs = require('node:fs')
const { createRequire } = require('node:module')
const path = require('node:path')

const { createEsmResolver, processModule } = require('../datadog-instrumentations/src/helpers/bundler-esm-exports')
const {
  createEsmWrapper,
  getEsmInterception,
  instrument,
  packagePathPattern,
} = require('../datadog-instrumentations/src/helpers/bundler-transform')
const { getGitMetadataBanner } = require('../datadog-instrumentations/src/helpers/bundler-utils')
const { getValueFromEnvSources } = require('../dd-trace/src/config/helper')
const log = require('./src/log')

const PLUGIN_NAME = 'datadog-vite'
// Ids starting with `\0dd-trace-vite:` are reserved for the wrappers this plugin generates to intercept the exports
// of ES modules, followed by the id of the wrapped module.
const GENERATED_ID_PREFIX = '\0dd-trace-vite:'
const LOAD_ID_PATTERN = /^\0dd-trace-vite:/
// Relative, absolute and package `imports` specifiers may resolve to an instrumented file, bare specifiers only when
// they name an instrumented package.
const RESOLVE_ID_PATTERN = new RegExp(String.raw`^(?:[./#]|[A-Za-z]:[/\\])|${packagePathPattern.source}`)
const NODE_MODULES = '/node_modules/'
const TRACER_DIRECTORY = `${fs.realpathSync(path.join(__dirname, '..', '..')).replaceAll('\\', '/')}/`
// Optional dependencies of the tracer, required lazily. They must stay out of the bundle: some are native addons and
// any of them may be missing at runtime.
const OPTIONAL_DEPENDENCY_PATTERN =
  /^(@datadog\/(?:libdatadog(?:-extras)?|native-appsec|native-iast-taint-tracking|native-metrics|pprof|wasm-js-rewriter)|@opentelemetry\/api(?:-logs)?|oxc-parser)(?:\/|$)/
// Pure JavaScript optional dependencies the application may import too. When installed, they are bundled, so the
// tracer and the application share one copy that does not need to be deployed next to the bundle.
const BUNDLED_WHEN_INSTALLED = ['@opentelemetry/api', '@opentelemetry/api-logs']
// Rollup leaves `require`, `__filename` and `__dirname` as free variables in ESM output, where Node.js lacks them.
// Rollup reserves these names in every chunk, so declaring them cannot collide with bundled code, and keeping them
// chunk-local resolves each chunk against its own location instead of whichever bundle loaded first.
const ESM_COMMONJS_BINDINGS = 'import { createRequire as $dd_createRequire } from \'node:module\';\n' +
  'import { fileURLToPath as $dd_fileURLToPath } from \'node:url\';\n' +
  'import { dirname as $dd_dirname } from \'node:path\';\n' +
  'const require = $dd_createRequire(import.meta.url);\n' +
  'const __filename = $dd_fileURLToPath(import.meta.url);\n' +
  'const __dirname = $dd_dirname(__filename);\n'
const ESM_FORMATS = new Set(['es', 'esm', 'module'])
const mergedFunctions = new WeakSet()

/**
 * @typedef {(id: string, parentId: string | undefined, isResolved: boolean) => unknown} ExternalFunction
 * @typedef {string | RegExp | ExternalFunction | Array<string | RegExp | ExternalFunction>} External
 * @typedef {string | ((chunk: object) => string | Promise<string>)} Addon
 * @typedef {{ format?: string, intro?: Addon, keepNames?: boolean }} OutputOptions
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
 * @typedef {{
 *   build: BuildOptions,
 *   builder?: { sharedConfigBuild?: boolean },
 *   environments: Record<string, { build: BuildOptions, consumer: string } | undefined>,
 *   esbuild: false | { keepNames?: boolean },
 * }} ResolvedConfig
 * @typedef {{ meta?: { rolldownVersion?: string } } | undefined} HookContext
 * @typedef {{ warn: (message: string) => void }} TransformContext
 * @typedef {{ name: string, config: { build: BuildOptions, consumer: string } }} Environment
 * @typedef {{ external?: boolean | string, id: string }} ResolvedId
 * @typedef {{ isEntry?: boolean, skipSelf?: boolean }} ResolveOptions
 * @typedef {{
 *   environment?: object,
 *   resolve: (source: string, importer: string | undefined, options: ResolveOptions) => Promise<ResolvedId | null>,
 *   warn: (message: string) => void,
 * }} ResolveContext
 * @typedef {{ dcModule: string, publications: Array<{ package: string, path: string, version: string }> }} Interception
 */

/**
 * Creates the Datadog plugin for Vite builds producing Node.js code.
 */
function datadogVite () {
  const injectGitMetadata = getValueFromEnvSources('DD_BUNDLER_INJECT_GIT_METADATA') !== false
  const installed = getInstalledDependencies()
  /** @type {WeakMap<object, EsmInterception>} */
  const interceptions = new WeakMap()
  const defaultEnvironment = {}
  /** @type {string|undefined} */
  let gitIntro

  if (!injectGitMetadata) log.debug('Skipping git metadata injection (DD_BUNDLER_INJECT_GIT_METADATA=false)')

  /**
   * @param {{ environment?: object }} context
   */
  function getInterception (context) {
    const environment = context.environment ?? defaultEnvironment
    let interception = interceptions.get(environment)
    if (!interception) {
      interception = new EsmInterception()
      interceptions.set(environment, interception)
    }
    return interception
  }

  return {
    name: PLUGIN_NAME,
    apply: 'build',
    enforce: 'pre',

    /**
     * Vite has normalized each environment's defaults, but has not created its CommonJS plugins yet.
     * The shared esbuild options are read later, when chunks are rendered.
     *
     * @this {HookContext}
     * @param {ResolvedConfig} config
     */
    configResolved (config) {
      // Older versions lack the Environment API hooks, so the build would silently miss required configuration.
      if (!config.environments) throw new Error('dd-trace/vite requires Vite 6 or newer. Refusing to bundle.')
      const rolldown = isRolldown(this)
      for (const [name, environment] of Object.entries(config.environments)) {
        if (environment && isNodeBuild(environment.consumer, environment.build)) {
          configureBuild(name, environment.build, rolldown, installed)
        }
      }
      if (rolldown || !config.esbuild || !needsEsbuildKeepNames(config)) return
      config.esbuild.keepNames = true
      log.debug('Enabled esbuild keepNames so minification preserves function and class names')
    },

    /**
     * Rolldown defines its own `require` in ESM output. Every chunk gets the bindings, since free variables in one
     * chunk cannot see declarations in another.
     *
     * @this {HookContext}
     * @param {OutputOptions} output
     */
    outputOptions (output) {
      if (isRolldown(this) || !ESM_FORMATS.has(output.format ?? 'es')) return
      return { ...output, intro: prependAddon(ESM_COMMONJS_BINDINGS, output.intro) }
    },

    /**
     * @param {Environment} environment
     */
    applyToEnvironment (environment) {
      const { build, consumer } = environment.config
      return isNodeBuild(consumer, build)
    },

    resolveId: {
      filter: { id: RESOLVE_ID_PATTERN },
      /**
       * @this {ResolveContext}
       * @param {string} source
       * @param {string} [importer]
       * @param {ResolveOptions} [options]
       */
      handler (source, importer, options) {
        return getInterception(this).resolveId(this, source, importer, options)
      },
    },

    load: {
      filter: { id: LOAD_ID_PATTERN },
      /**
       * @this {ResolveContext}
       * @param {string} id
       */
      handler (id) {
        return isWrapperId(id) ? getInterception(this).load(this, id.slice(GENERATED_ID_PREFIX.length)) : undefined
      },
    },

    /**
     * @this {{ environment?: object }}
     */
    buildEnd () {
      return interceptions.get(this.environment ?? defaultEnvironment)?.buildEnd()
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
        const result = isInstrumentable(id)
          ? instrument({ source: code, resourcePath: id, warn: warning => this.warn(warning.message) })
          : undefined
        return result && result.code !== code ? { code: result.code, map: result.map ?? null } : undefined
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
 * @param {string} id
 */
function isInstrumentable (id) {
  return id.charCodeAt(0) !== 0 && !id.includes('?') && id.includes(NODE_MODULES) &&
    !id.startsWith(TRACER_DIRECTORY) && packagePathPattern.test(id)
}

/**
 * @param {string} id
 */
function isWrapperId (id) {
  return id.startsWith(GENERATED_ID_PREFIX)
}

/**
 * ES module namespaces are read-only, so hooks cannot replace the exports of ES modules. Importers of ES modules that
 * hooks instrument are redirected to a wrapper module re-exporting them through bindings the hooks can replace.
 * Orchestrion targets are rewritten in place instead. State is kept per environment.
 */
class EsmInterception {
  /**
   * Kept across watch mode rebuilds, which load cached modules without resolving their imports again.
   *
   * @type {Map<string, Interception>}
   */
  #interceptions = new Map()
  /** @type {Map<string, Promise<string[] | undefined>>} */
  #exports = new Map()
  /** @type {Map<string, string>} */
  #moduleSources = new Map()
  /** @type {ReturnType<typeof createEsmResolver> | undefined} */
  #resolver

  /**
   * @param {ResolveContext} context
   * @param {string} source
   * @param {string | undefined} importer
   * @param {ResolveOptions | undefined} options
   */
  resolveId (context, source, importer, options) {
    if (importer === undefined || options?.isEntry) return
    if (isWrapperId(importer)) {
      // The wrapper imports the wrapped module and the diagnostic channel module of the tracer, both relative to the
      // wrapped module, and must reach the wrapped module itself.
      return context.resolve(source, importer.slice(GENERATED_ID_PREFIX.length), { ...options, skipSelf: true })
    }
    if (!mayResolveToTarget(source, importer)) return
    return context.resolve(source, importer, { ...options, skipSelf: true })
      .then(resolved => this.#redirect(context, source, importer, resolved))
  }

  /**
   * @param {ResolveContext} context
   * @param {string} id The id of the wrapped module.
   */
  load (context, id) {
    const interception = this.#interceptions.get(id)
    return this.#getExports(context, id).then(setters => {
      if (!setters) throw new Error(`Could not analyze the exports of ${id}`)
      return createEsmWrapper({
        dcModule: interception?.dcModule ?? '',
        publications: interception?.publications ?? [],
        resourcePath: id,
        setters,
      })
    })
  }

  buildEnd () {
    const resolver = this.#resolver
    this.#exports.clear()
    this.#moduleSources.clear()
    this.#resolver = undefined
    return resolver?.close().catch(error => {
      log.debug('The ESM resolver failed: %s', error instanceof Error ? error.message : String(error))
    })
  }

  /**
   * @param {ResolveContext} context
   * @param {string} source
   * @param {string} importer
   * @param {ResolvedId | null} resolved
   */
  #redirect (context, source, importer, resolved) {
    // A module importing itself must not reach its wrapper, which would import it in turn.
    if (!resolved || resolved.external || resolved.id === importer || !isInstrumentable(resolved.id)) return resolved
    const { id } = resolved
    const interception = getEsmInterception({
      resourcePath: id,
      // Package root hooks only apply to imports of the package name.
      request: isBareSpecifier(source) ? source : undefined,
      warn: warning => context.warn(warning.message),
    })
    if (!interception) return resolved
    this.#addInterception(id, interception)
    return this.#getExports(context, id).then(setters => {
      if (!setters) return resolved
      // The wrapper publishes the module to the tracer, even when importers only re-export it.
      return { id: GENERATED_ID_PREFIX + id, moduleSideEffects: true }
    })
  }

  /**
   * Importers may resolve the same file with and without the package name, so publications are merged.
   *
   * @param {string} id
   * @param {Interception} interception
   */
  #addInterception (id, interception) {
    const existing = this.#interceptions.get(id)
    if (!existing) {
      this.#interceptions.set(id, { dcModule: interception.dcModule, publications: [...interception.publications] })
      return
    }
    for (const publication of interception.publications) {
      if (!existing.publications.some(({ path }) => path === publication.path)) existing.publications.push(publication)
    }
  }

  /**
   * @param {ResolveContext} context
   * @param {string} id
   * @returns {Promise<string[] | undefined>}
   */
  #getExports (context, id) {
    const cached = this.#exports.get(id)
    if (cached) return cached
    this.#resolver ??= createEsmResolver()
    const exports = /** @type {Promise<string[] | undefined>} */ (processModule({
      path: id,
      context: { format: 'module' },
      moduleSources: this.#moduleSources,
      resolver: this.#resolver,
    }).then(setters => [...setters.values()], error => {
      context.warn(`Skipped intercepting the exports of ${id}: ${error instanceof Error ? error.message : error}`)
    }))
    this.#exports.set(id, exports)
    return exports
  }
}

/**
 * Relative specifiers can only resolve to an instrumented file when imported from an instrumented package.
 *
 * @param {string} source
 * @param {string} importer
 */
function mayResolveToTarget (source, importer) {
  if (source.charCodeAt(0) === 0 || source.includes('?')) return false
  return source[0] === '.' || source[0] === '#' ? isInstrumentable(importer) : packagePathPattern.test(source)
}

/**
 * @param {string} source
 */
function isBareSpecifier (source) {
  return source[0] !== '.' && source[0] !== '/' && source[0] !== '#' && !/^[A-Za-z]:[/\\]/.test(source)
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
 * Resolves the optional dependencies that are bundled when installed the way the bundled tracer would.
 *
 * @returns {Set<string>}
 */
function getInstalledDependencies () {
  const tracerRequire = createRequire(`${TRACER_DIRECTORY}index.js`)
  const installed = new Set()
  for (const name of BUNDLED_WHEN_INSTALLED) {
    try {
      tracerRequire.resolve(name)
      installed.add(name)
    } catch {
      log.debug('Keeping %s external to the bundle: it is not installed', name)
    }
  }
  return installed
}

/**
 * @param {string} id
 * @param {Set<string>} installed
 */
function isOptionalDependency (id, installed) {
  const match = OPTIONAL_DEPENDENCY_PATTERN.exec(id)
  return match !== null && !installed.has(match[1])
}

/**
 * @param {string | undefined} id
 */
function isTracerModule (id) {
  if (id === undefined) return false
  const normalized = id.replaceAll('\\', '/')
  return normalized.startsWith(TRACER_DIRECTORY) || normalized.includes('/node_modules/dd-trace/')
}

/**
 * @param {Addon} code
 * @param {Addon | undefined} addon
 * @returns {Addon}
 */
function prependAddon (code, addon) {
  if (typeof addon === 'function') return async chunk => `${code}${await addon(chunk)}`
  return addon ? `${code}${addon}` : code
}

/**
 * @param {string} name
 * @param {BuildOptions} build
 * @param {boolean} rolldown
 * @param {Set<string>} installed
 */
function configureBuild (name, build, rolldown, installed) {
  const { minify } = build
  if (rolldown) {
    // Vite 8 aliases `rollupOptions` to `rolldownOptions`; reuse whichever object the configuration already has.
    const options = build.rolldownOptions ?? build.rollupOptions ?? (build.rolldownOptions = {})
    options.external = mergeExternal(options.external, installed)
    if (minify) enableOutputKeepNames(name, options)
  } else {
    // Rollup hoists external `require` calls to the top of the chunk, which would load optional dependencies eagerly
    // and crash when they are missing. Ignored `require` calls stay where they are. The option only receives the
    // required id, so it also applies to other bundled CommonJS modules; those dependencies are native addons or
    // missing, which these modules could not bundle either.
    const commonjsOptions = build.commonjsOptions ??= {}
    commonjsOptions.ignore = mergeIgnore(commonjsOptions.ignore, installed)
  }
  if (minify === 'terser') {
    const terserOptions = build.terserOptions ??= {}
    terserOptions.keep_classnames ??= true
    terserOptions.keep_fnames ??= true
    log.debug('Enabled terser keep_classnames and keep_fnames for the %s environment', name)
  }
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
 * Only imports from the tracer are externalized, so the application still bundles its own imports of these packages.
 *
 * @param {External | null | undefined} external
 * @param {Set<string>} installed
 * @returns {ExternalFunction}
 */
function mergeExternal (external, installed) {
  if (typeof external === 'function' && mergedFunctions.has(external)) return external
  const user = external === undefined || external === null ? undefined : matchAny(external)
  /** @type {ExternalFunction} */
  const merged = (id, parentId, isResolved) =>
    (isOptionalDependency(id, installed) && isTracerModule(parentId)) || Boolean(user?.(id, parentId, isResolved))
  mergedFunctions.add(merged)
  return merged
}

/**
 * Vite concatenates arrays when merging configurations, so a function returned by one plugin or the user can end up
 * in an array, which the bundler rejects.
 *
 * @param {External} external
 * @returns {ExternalFunction}
 */
function matchAny (external) {
  if (typeof external === 'function') return external
  const externals = Array.isArray(external) ? external : [external]
  return (id, parentId, isResolved) => externals.some(entry => {
    if (typeof entry === 'function') return entry(id, parentId, isResolved)
    return typeof entry === 'string' ? entry === id : entry.test(id)
  })
}

/**
 * @param {string[] | ((id: string) => boolean) | undefined} ignore
 * @param {Set<string>} installed
 * @returns {(id: string) => boolean}
 */
function mergeIgnore (ignore, installed) {
  if (typeof ignore === 'function' && mergedFunctions.has(ignore)) return ignore
  let merged
  if (typeof ignore === 'function') {
    merged = (/** @type {string} */ id) => isOptionalDependency(id, installed) || ignore(id)
  } else {
    const ids = new Set(ignore)
    merged = (/** @type {string} */ id) => isOptionalDependency(id, installed) || ids.has(id)
  }
  mergedFunctions.add(merged)
  return merged
}

module.exports = { datadogVite }
