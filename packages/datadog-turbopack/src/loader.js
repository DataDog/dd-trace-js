'use strict'

const fs = require('node:fs')
const { builtinModules } = require('node:module')
const path = require('node:path')
const { fileURLToPath, pathToFileURL } = require('node:url')

const {
  createWrapperModule,
  getNodeModuleFormat,
  getPackageDetails,
} = require('import-in-the-middle/bundler')

const {
  getBundlerTarget,
  getBundlerTargetByPath,
  isPackageOfInterest,
} = require('../../datadog-instrumentations/src/helpers/bundler-target')
const { createBundlerRewriter } = require('../../datadog-instrumentations/src/helpers/rewriter')
const { SYNTHETIC_EXTENSION } = require('./constants')
const { parseSource } = require('./compiler')

const BUILTIN_MODULES = new Set(builtinModules)
const IMPORT_RESOLVE_OPTIONS = { conditionNames: ['...', 'node', 'import'] }
const ORIGINAL_QUERY = '__dd_iitm_original'
const REQUIRE_RESOLVE_OPTIONS = { conditionNames: ['...', 'node', 'require'] }

let cachedDcModule
/** @type {Function|undefined} */
let cachedRewriter

/**
 * @typedef {object} ResolvedTarget
 * @property {string} [integration]
 * @property {string|undefined} format
 * @property {string} moduleName
 * @property {string} package
 * @property {string} path
 * @property {string} url
 * @property {string|undefined} version
 */

/**
 * @typedef {object} LoaderOptions
 * @property {{ parser: string, traverse: string }} compiler
 */

/**
 * @typedef {object} LoaderContext
 * @property {(file: string) => void} addDependency
 * @property {(warning: Error) => void} [emitWarning]
 * @property {Function} async
 * @property {Function} getOptions
 * @property {Function} getResolve
 * @property {string} [resourceQuery]
 * @property {string} resourcePath
 */

/**
 * Instruments modules selected from their resolved package identity.
 *
 * @this {LoaderContext}
 * @param {string} source
 * @param {object} [inputSourceMap]
 * @returns {void}
 */
module.exports = function loader (source, inputSourceMap) {
  const callback = this.async()
  load.call(this, source, inputSourceMap).then(
    ({ code, map }) => callback(undefined, code, map),
    (error) => {
      this.emitWarning?.(error instanceof Error ? error : new Error(String(error)))
      callback(undefined, source, inputSourceMap)
    }
  )
}

/**
 * @this {LoaderContext}
 * @param {string} source
 * @param {object|undefined} inputSourceMap
 * @returns {Promise<{ code: string, map?: object }>}
 */
async function load (source, inputSourceMap) {
  const options = getLoaderOptions(this.getOptions())
  const nativeResourcePath = fs.realpathSync(getResourcePath(this))
  const resourcePath = nativeResourcePath.replaceAll('\\', '/')
  const target = await findTarget(resourcePath, this)
  if (target === undefined) return { code: source, map: inputSourceMap }

  target.format ??= getSourceFormat(source, resourcePath, options.compiler)
  const rewritten = rewriteTarget(source, inputSourceMap, resourcePath, target)
  const originalRequest = new URLSearchParams(this.resourceQuery).get(ORIGINAL_QUERY)
  if (originalRequest === target.moduleName) return rewritten

  if (target.format === 'module' || target.format === 'module-typescript') {
    return wrapESM(rewritten.code, resourcePath, target, options, this)
  }
  return wrapCommonJS(rewritten.code, rewritten.map, resourcePath, target, this)
}

/**
 * @param {unknown} value
 * @returns {LoaderOptions}
 */
function getLoaderOptions (value) {
  const options = /** @type {LoaderOptions} */ (value)
  if (typeof options?.compiler?.parser !== 'string' || typeof options.compiler.traverse !== 'string') {
    throw new TypeError('The Datadog Turbopack loader options are invalid')
  }
  return options
}

/**
 * @param {LoaderContext} context
 * @returns {string}
 */
function getResourcePath (context) {
  const { resourcePath } = context
  if (!resourcePath.endsWith(SYNTHETIC_EXTENSION) || fs.existsSync(resourcePath)) return resourcePath

  const extensionlessPath = resourcePath.slice(0, -SYNTHETIC_EXTENSION.length)
  return fs.existsSync(extensionlessPath) ? extensionlessPath : resourcePath
}

/**
 * @param {string} resourcePath
 * @param {LoaderContext} loaderContext
 * @returns {Promise<ResolvedTarget|undefined>}
 */
async function findTarget (resourcePath, loaderContext) {
  const url = pathToFileURL(resourcePath).href
  const pathTarget = getBundlerTargetByPath(url)
  if (pathTarget !== undefined) return pathTarget

  const details = getPackageDetails(url)
  if (details !== undefined && isPackageOfInterest(details.name) &&
    await isPackageRoot(resourcePath, details.name, fileURLToPath(details.packageUrl), loaderContext)) {
    return getBundlerTarget(details.name, url)
  }
}

/**
 * @param {string} resourcePath
 * @param {string} packageName
 * @param {string} packageDirectory
 * @param {LoaderContext} loaderContext
 * @returns {Promise<boolean>}
 */
async function isPackageRoot (resourcePath, packageName, packageDirectory, loaderContext) {
  const resolvers = [
    loaderContext.getResolve(IMPORT_RESOLVE_OPTIONS),
    loaderContext.getResolve(REQUIRE_RESOLVE_OPTIONS),
  ]
  const results = await Promise.allSettled(
    resolvers.map(resolver => resolveRequest(resolver, packageDirectory, packageName))
  )
  for (const result of results) {
    if (result.status === 'rejected') continue
    const resolvedPath = getPlainResolvedPath(result.value)
    if (resolvedPath !== undefined && fs.realpathSync(resolvedPath).replaceAll('\\', '/') === resourcePath) {
      return true
    }
  }
  return false
}

/**
 * @param {Function} resolver
 * @param {string} context
 * @param {string} specifier
 * @returns {Promise<string>}
 */
function resolveRequest (resolver, context, specifier) {
  return new Promise((resolve, reject) => {
    resolver(context, specifier, (error, value) => {
      if (error) {
        reject(error)
      } else {
        resolve(value)
      }
    })
  })
}

/**
 * @param {unknown} resolved
 * @returns {string|undefined}
 */
function getPlainResolvedPath (resolved) {
  if (typeof resolved !== 'string') return
  if (!path.isAbsolute(resolved) || resolved.includes('?') || resolved.includes('#') || resolved.includes('!')) return
  return resolved
}

/**
 * @param {string} specifier
 * @param {string} name
 * @param {string} value
 * @returns {string}
 */
function appendQuery (specifier, name, value) {
  return `${specifier}?${name}=${encodeURIComponent(value)}`
}

/**
 * @param {string|Buffer} source
 * @param {string} resourcePath
 * @param {{ parser: string, traverse: string }} compiler
 * @returns {'commonjs'|'module'}
 */
function getSourceFormat (source, resourcePath, compiler) {
  let parsed
  try {
    parsed = parseSource(source.toString(), resourcePath, compiler, 'unambiguous')
  } catch {
    parsed = parseSource(source.toString(), resourcePath, compiler, 'commonjs')
  }
  return parsed.ast.program.sourceType === 'module' ? 'module' : 'commonjs'
}

/**
 * @param {string|Buffer} source
 * @param {string} resourcePath
 * @param {ResolvedTarget} target
 * @param {LoaderOptions} options
 * @param {LoaderContext} loaderContext
 * @returns {Promise<{ code: string }>}
 */
async function wrapESM (source, resourcePath, target, options, loaderContext) {
  const parsed = parseSource(source.toString(), resourcePath, options.compiler, 'module')

  /**
   * @param {Array<{ name: string, url: string, localName?: string }>} exports
   * @returns {string[]}
   */
  function selectPassthroughExports (exports) {
    return findLiveExports(exports, options.compiler, resourcePath, parsed)
  }

  const wrapper = await createWrapperModule({
    module: {
      url: target.url,
      format: target.format,
      source,
      specifier: target.package,
      data: { integration: target.integration, moduleName: target.moduleName, version: target.version },
      passthroughExports: selectPassthroughExports,
    },
    resolve: createResolveAdapter(loaderContext),
    load: loadModule,
  })

  const code = mapWrapperImports(wrapper, resourcePath, target)
  for (const watchFile of wrapper.watchFiles) {
    if (watchFile.startsWith('file:')) loaderContext.addDependency(fileURLToPath(watchFile))
  }
  return { code }
}

/**
 * @param {LoaderContext} loaderContext
 * @returns {(specifier: string, context: { parentURL: string }) => Promise<{
 *   url: string, format?: string, watchFiles?: string[]
 * }>}
 */
function createResolveAdapter (loaderContext) {
  const resolve = loaderContext.getResolve(IMPORT_RESOLVE_OPTIONS)

  /**
   * @param {string} specifier
   * @param {{ parentURL: string }} context
   * @returns {Promise<{ url: string, format?: string, watchFiles?: string[] }>}
   */
  return async function resolveModule (specifier, context) {
    if (specifier.startsWith('node:') || BUILTIN_MODULES.has(specifier)) {
      return { url: specifier, format: 'builtin' }
    }
    if (specifier.startsWith('file:')) {
      return { url: specifier, format: getNodeModuleFormat(specifier), watchFiles: [specifier] }
    }

    const parentPath = fileURLToPath(context.parentURL)
    const resolved = await resolveRequest(resolve, path.dirname(parentPath), specifier)
    const resolvedPath = getPlainResolvedPath(resolved)
    if (resolvedPath === undefined) throw new Error(`Could not resolve ${specifier} to a file`)
    const url = pathToFileURL(resolvedPath).href
    return { url, format: getNodeModuleFormat(url), watchFiles: [url] }
  }
}

/**
 * @param {string} url
 * @param {{ format?: string }} context
 * @returns {{ source?: Buffer, format?: string, watchFiles?: string[] }}
 */
function loadModule (url, context) {
  if (!url.startsWith('file:')) return { format: context.format }

  const filename = fileURLToPath(url)
  return {
    source: fs.readFileSync(filename),
    format: context.format ?? getNodeModuleFormat(url),
    watchFiles: [url],
  }
}

/**
 * @param {Awaited<ReturnType<typeof createWrapperModule>>} wrapper
 * @param {string} resourcePath
 * @param {ResolvedTarget} target
 * @returns {string}
 */
function mapWrapperImports (wrapper, resourcePath, target) {
  let code = wrapper.code
  for (const entry of wrapper.imports) {
    let replacement = entry.target.url
    if (replacement.startsWith('file:')) {
      replacement = relativeImport(path.dirname(resourcePath), fileURLToPath(replacement))
      if (entry.target.url === target.url) {
        replacement = appendQuery(replacement, ORIGINAL_QUERY, target.moduleName)
      }
    }
    code = code.replaceAll(JSON.stringify(entry.specifier), JSON.stringify(replacement))
  }
  return code
}

/**
 * @param {Array<{ name: string, url: string, localName?: string }>} exports
 * @param {{ parser: string, traverse: string }} compiler
 * @param {string} resourcePath
 * @param {{ ast: object, traverse: Function }} parsed
 * @returns {string[]}
 */
function findLiveExports (exports, compiler, resourcePath, parsed) {
  const exportsByUrl = new Map()
  for (const binding of exports) {
    if (binding.localName === undefined || !binding.url.startsWith('file:')) continue
    const bindings = exportsByUrl.get(binding.url) ?? []
    bindings.push(binding)
    exportsByUrl.set(binding.url, bindings)
  }

  const liveExports = []
  for (const [url, bindings] of exportsByUrl) {
    const modulePath = fs.realpathSync(fileURLToPath(url)).replaceAll('\\', '/')
    const parsedModule = modulePath === resourcePath
      ? parsed
      : parseSource(fs.readFileSync(modulePath, 'utf8'), modulePath, compiler, 'module')
    parsedModule.traverse(parsedModule.ast, {
      /** @param {{ scope: { getBinding: Function } }} programPath */
      Program (programPath) {
        for (const binding of bindings) {
          if (programPath.scope.getBinding(binding.localName)?.constant === false) liveExports.push(binding.name)
        }
      },
    })
  }
  return liveExports.sort()
}

/**
 * @param {string|Buffer} source
 * @param {object|undefined} sourceMap
 * @param {string} resourcePath
 * @param {ResolvedTarget} target
 * @returns {{ code: string, map?: object }}
 */
function rewriteTarget (source, sourceMap, resourcePath, target) {
  const dcModule = relativeImport(path.dirname(resourcePath), require.resolve('dc-polyfill'))
  if (cachedDcModule !== dcModule) {
    cachedDcModule = dcModule
    cachedRewriter = createBundlerRewriter(dcModule)
  }
  return /** @type {{ code: string, map?: object }} */ (cachedRewriter(
    source,
    resourcePath,
    target.format === 'module' || target.format === 'module-typescript' ? 'module' : 'commonjs',
    { filePath: target.path, moduleName: target.package },
    sourceMap
  ))
}

/**
 * @param {string|Buffer} source
 * @param {object|undefined} sourceMap
 * @param {string} resourcePath
 * @param {ResolvedTarget} target
 * @param {LoaderContext} loaderContext
 * @returns {Promise<{ code: string, map?: object }>}
 */
async function wrapCommonJS (source, sourceMap, resourcePath, target, loaderContext) {
  const url = pathToFileURL(resourcePath).href
  const wrapper = await createWrapperModule({
    module: {
      url,
      format: target.format,
      source,
      specifier: target.package,
      data: { integration: target.integration, moduleName: target.moduleName, version: target.version },
    },
  })

  let code = wrapper.code
  for (const entry of wrapper.imports) {
    const replacement = relativeImport(path.dirname(resourcePath), fileURLToPath(entry.target.url))
    code = code.replaceAll(JSON.stringify(entry.specifier), JSON.stringify(replacement))
  }
  for (const watchFile of wrapper.watchFiles) {
    if (watchFile.startsWith('file:')) loaderContext.addDependency(fileURLToPath(watchFile))
  }
  const map = /** @type {{ mappings: string }|undefined} */ (sourceMap)
  if (map && wrapper.sourceLineOffset) map.mappings = ';'.repeat(wrapper.sourceLineOffset) + map.mappings
  return { code, map }
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
function relativeImport (from, to) {
  let value = path.relative(from, to).replaceAll('\\', '/')
  if (!value.startsWith('.')) value = `./${value}`
  return value
}
