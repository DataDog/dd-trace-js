'use strict'

const Module = require('node:module')
const { fileURLToPath } = require('node:url')

const { getEnvironmentVariable } = require('../config/helper')
const log = require('../log')

/** @typedef {{ enabled: boolean, nodeModules: boolean, generatedCode: boolean }} SourceMapsSupport */
/**
 * @typedef {object} ProgrammaticSourceMaps
 * @property {() => SourceMapsSupport} getSourceMapsSupport
 * @property {(enabled: boolean, options: { nodeModules: boolean, generatedCode: boolean }) => void}
 *   setSourceMapsSupport
 */
/**
 * @typedef {object} SourceMapEntry
 * @property {string} [originalSource]
 * @property {number} [originalLine]
 * @property {number} [originalColumn]
 * @property {string} [name]
 */

const { findSourceMap } = Module
// eslint-disable-next-line n/no-unsupported-features/node-builtins
const { getSourceMapsSupport, setSourceMapsSupport } =
  /** @type {ProgrammaticSourceMaps} */ (/** @type {unknown} */ (Module))

const supportsProgrammaticSourceMaps = typeof setSourceMapsSupport === 'function'
const nativeSourceMapsEnabled = isNativeSourceMapSupportEnabled()
const legacySourceMapsEnabled = !supportsProgrammaticSourceMaps && nativeSourceMapsEnabled
const SOURCE_MAP_URL_CACHE_LIMIT = 1024

/** @type {WeakMap<NodeModule, import('node:module').SourceMap | null>} */
let sourceMapByModule = new WeakMap()
/** @type {Map<string, import('node:module').SourceMap | null>} */
const sourceMapByURL = new Map()
/** @type {WeakMap<import('node:module').SourceMap, Map<string, OriginalLocation | null>>} */
let locationsBySourceMap = new WeakMap()
/** @type {WeakMap<import('node:module').SourceMap, boolean>} */
const sourceMapHasNames = new WeakMap()

let installed = false
let generatedCodeEnabled = legacySourceMapsEnabled
let sourceMapsSupportState = -1
/** @type {((error: Error, callSites: NodeJS.CallSite[]) => unknown) | undefined} */
let delegatePrepareStackTrace
/** @type {((error: Error, callSites: NodeJS.CallSite[]) => unknown) | undefined} */
let defaultPrepareStackTrace

/**
 * Enable source-map support and install the lazy stack-trace remapper.
 *
 * @returns {void}
 */
function enable () {
  if (installed || !canResolveSourceMaps()) return

  if (supportsProgrammaticSourceMaps) {
    try {
      if (getSourceMapsSupport().enabled === false) {
        setSourceMapsSupport(true, { nodeModules: false, generatedCode: false })
      }
    } catch (error) {
      log.warn(
        'Unable to enable source map support: %s',
        getErrorMessage(error)
      )
      return
    }
  }

  try {
    const previousPrepareStackTrace = Error.prepareStackTrace
    if (typeof previousPrepareStackTrace !== 'function') {
      // Older releases keep the source-map-aware default formatter internal. Replacing it would
      // lose native error-code headers, while custom formatters still expose a function to wrap.
      installed = true
      return
    }
    if (isNodeDefaultPrepareStackTrace(previousPrepareStackTrace)) {
      defaultPrepareStackTrace = previousPrepareStackTrace
      delegatePrepareStackTrace = undefined
    } else {
      defaultPrepareStackTrace = undefined
      delegatePrepareStackTrace = previousPrepareStackTrace
    }
    Error.prepareStackTrace = prepareStackTrace
    installed = true
  } catch (error) {
    defaultPrepareStackTrace = undefined
    delegatePrepareStackTrace = undefined
    log.warn(
      'Unable to install the source map stack trace formatter: %s',
      getErrorMessage(error)
    )
  }
}

/**
 * @returns {boolean} Whether this runtime can resolve source maps.
 */
function canResolveSourceMaps () {
  return supportsProgrammaticSourceMaps || legacySourceMapsEnabled
}

/**
 * @returns {boolean} Whether source maps are enabled by the effective Node options.
 */
function isNativeSourceMapSupportEnabled () {
  let enabled = false
  const nodeOptions = parseNodeOptions(getEnvironmentVariable('NODE_OPTIONS'))
  for (let i = 0; i < nodeOptions.length; i++) {
    enabled = applySourceMapsFlag(nodeOptions[i], enabled)
  }
  for (let i = 0; i < process.execArgv.length; i++) {
    enabled = applySourceMapsFlag(process.execArgv[i], enabled)
  }
  return enabled
}

/**
 * Node processes `NODE_OPTIONS` before command-line arguments. This parser only needs to preserve
 * token boundaries and quotes so option values cannot masquerade as source-map flags.
 *
 * @param {string | undefined} value
 * @returns {string[]}
 */
function parseNodeOptions (value) {
  if (!value) return []

  const options = []
  let option = ''
  let quoted = false
  for (let i = 0; i < value.length; i++) {
    const character = value[i]
    if (character === '\\' && quoted) {
      if (++i === value.length) return []
      option += value[i]
    } else if (character === '"') {
      quoted = !quoted
    } else if (character === ' ' && !quoted) {
      if (option) {
        options.push(option)
        option = ''
      }
    } else {
      option += character
    }
  }
  if (quoted) return []
  if (option) options.push(option)
  return options
}

/**
 * @param {string} option
 * @param {boolean} enabled
 * @returns {boolean}
 */
function applySourceMapsFlag (option, enabled) {
  if (option === '--no-enable-source-maps' || option.startsWith('--no-enable-source-maps=')) {
    return false
  }
  if (option === '--enable-source-maps' || option.startsWith('--enable-source-maps=')) {
    return true
  }
  return enabled
}

/**
 * Synchronize the current support options once per formatted stack. Other libraries can change these
 * options after tracer initialization, so caches from a previous support state must not leak
 * remapped locations into the new state.
 *
 * @returns {boolean}
 */
function syncSourceMapSupport () {
  if (!supportsProgrammaticSourceMaps) {
    return legacySourceMapsEnabled
  }

  let support
  try {
    support = getSourceMapsSupport()
  } catch (error) {
    log.warn(
      'Unable to read source map support: %s',
      getErrorMessage(error)
    )
    return false
  }

  const { enabled, generatedCode, nodeModules } = support
  const state = (enabled ? 1 : 0) | (nodeModules ? 2 : 0) | (generatedCode ? 4 : 0)
  if (state !== sourceMapsSupportState) {
    sourceMapByModule = new WeakMap()
    sourceMapByURL.clear()
    locationsBySourceMap = new WeakMap()
    sourceMapsSupportState = state
  }
  generatedCodeEnabled = generatedCode
  return enabled
}

/**
 * Node's default formatter is implemented in JavaScript, so checking only its function name would
 * mistake a user formatter with the same name for Node's implementation.
 *
 * @param {unknown} handler
 * @returns {boolean}
 */
function isNodeDefaultPrepareStackTrace (handler) {
  return typeof handler === 'function' &&
    handler.name === 'ErrorPrepareStackTrace' &&
    Function.prototype.toString.call(handler).includes('return internalPrepareStackTrace(error, trace);')
}

/**
 * @param {Error} error
 * @param {NodeJS.CallSite[]} callSites
 * @returns {unknown}
 */
function prepareStackTrace (error, callSites) {
  const shouldRemap = syncSourceMapSupport()
  if (typeof delegatePrepareStackTrace === 'function') {
    return delegatePrepareStackTrace.call(
      Error,
      error,
      shouldRemap ? callSites.map(toOriginalCallSite) : callSites
    )
  }

  let result = defaultPrepareStackTrace.call(Error, error, [])
  for (let i = 0; i < callSites.length; i++) {
    const callSite = callSites[i]
    result += `\n    at ${shouldRemap ? formatCallSite(callSite, undefined, callSites[i + 1]) : callSite}`
  }
  return result
}

/**
 * Format a frame as V8 would, replacing only its trailing generated location.
 *
 * @param {NodeJS.CallSite} callSite
 * @param {OriginalLocation} [original]
 * @param {NodeJS.CallSite} [callerCallSite]
 * @returns {string}
 */
function formatCallSite (callSite, original, callerCallSite) {
  const fileName = getGeneratedFileName(callSite)
  if (!fileName) return callSite.toString()

  const lineNumber = callSite.getLineNumber()
  const columnNumber = callSite.getColumnNumber()
  const generatedFileName = callSite.getFileName()
  original ??= resolveLocation(
    fileName,
    lineNumber,
    columnNumber,
    generatedFileName !== undefined && generatedFileName !== null
  )
  if (original === undefined) return callSite.toString()

  const frame = callSite.toString()
  const renderedFileName = callSite.getScriptNameOrSourceURL() ?? fileName
  const generatedLocation = columnNumber === null
    ? `${renderedFileName}:${lineNumber}`
    : `${renderedFileName}:${lineNumber}:${columnNumber}`
  const index = frame.lastIndexOf(generatedLocation)
  if (index === -1) return frame

  let prefix = frame.slice(0, index)
  const originalName = getOriginalSymbolName(original, callSite, callerCallSite)
  const generatedName = callSite.getFunctionName() ?? callSite.getMethodName()
  if (originalName !== undefined && generatedName) {
    const aliasIndex = prefix.indexOf(' [as ')
    const nameEnd = aliasIndex === -1 ? prefix.length : aliasIndex
    const nameIndex = prefix.lastIndexOf(generatedName, nameEnd - generatedName.length)
    if (nameIndex !== -1) {
      prefix = prefix.slice(0, nameIndex) + originalName + prefix.slice(nameIndex + generatedName.length)
    }
  }
  return prefix + original.formatted + frame.slice(index + generatedLocation.length)
}

/**
 * Eval and `Function` frames report their generated source URL through `getEvalOrigin()`.
 *
 * @param {NodeJS.CallSite} callSite
 * @returns {string | undefined}
 */
function getGeneratedFileName (callSite) {
  return callSite.getFileName() ?? (generatedCodeEnabled ? callSite.getEvalOrigin?.() : undefined)
}

/**
 * Use the enclosing or caller mapping in the same way as Node's source-map formatter. Most maps
 * have no names, so the payload check avoids extra source-map lookups on the common path.
 *
 * @param {OriginalLocation} original
 * @param {NodeJS.CallSite} callSite
 * @param {NodeJS.CallSite} [callerCallSite]
 * @returns {string | undefined}
 */
function getOriginalSymbolName (original, callSite, callerCallSite) {
  const { sourceMap } = original
  if (!hasSourceMapNames(sourceMap)) return

  try {
    const enclosingLineNumber = callSite.getEnclosingLineNumber?.()
    const enclosingColumnNumber = callSite.getEnclosingColumnNumber?.()
    if (enclosingLineNumber !== null && enclosingLineNumber !== undefined &&
        enclosingColumnNumber !== null && enclosingColumnNumber !== undefined) {
      const enclosingEntry = /** @type {SourceMapEntry} */ (
        sourceMap.findEntry(enclosingLineNumber - 1, enclosingColumnNumber - 1)
      )
      if (enclosingEntry.name) return enclosingEntry.name
    }

    if (callerCallSite !== undefined &&
        getGeneratedFileName(callSite) === getGeneratedFileName(callerCallSite)) {
      const callerLineNumber = callerCallSite.getLineNumber()
      const callerColumnNumber = callerCallSite.getColumnNumber()
      if (callerLineNumber !== null && callerColumnNumber !== null) {
        const callerEntry = /** @type {SourceMapEntry} */ (
          sourceMap.findEntry(callerLineNumber - 1, callerColumnNumber - 1)
        )
        return callerEntry.name
      }
    }
  } catch {
    // A malformed name mapping must not make an otherwise formattable stack throw.
  }
}

/**
 * The public payload getter clones the payload and its arrays, so inspect it only once per map.
 *
 * @param {import('node:module').SourceMap} sourceMap
 * @returns {boolean}
 */
function hasSourceMapNames (sourceMap) {
  const cached = sourceMapHasNames.get(sourceMap)
  if (cached !== undefined) return cached

  let hasNames = false
  try {
    hasNames = Boolean(sourceMap.payload?.names?.length)
  } catch {
    // Symbol names are optional; location remapping can continue without the payload.
  }
  sourceMapHasNames.set(sourceMap, hasNames)
  return hasNames
}

/**
 * @param {string | null | undefined} fileName
 * @param {number | null} lineNumber
 * @param {number | null} columnNumber
 * @param {boolean} cacheSourceMapByURL
 * @returns {OriginalLocation | undefined}
 *
 * @typedef {object} OriginalLocation
 * @property {string} fileName
 * @property {number} lineNumber
 * @property {number} columnNumber
 * @property {string} formatted
 * @property {import('node:module').SourceMap} sourceMap
 */
function resolveLocation (fileName, lineNumber, columnNumber, cacheSourceMapByURL) {
  if (!fileName || lineNumber === null) return

  const sourceMap = getSourceMap(fileName, cacheSourceMapByURL)
  if (sourceMap === null) return

  let locations = locationsBySourceMap.get(sourceMap)
  if (locations === undefined) {
    locations = new Map()
    locationsBySourceMap.set(sourceMap, locations)
  }

  columnNumber ??= 1
  const cacheKey = `${lineNumber}:${columnNumber}`
  const cached = locations.get(cacheKey)
  if (cached !== undefined) return cached ?? undefined

  let entry
  try {
    entry = /** @type {SourceMapEntry} */ (sourceMap.findEntry(lineNumber - 1, columnNumber - 1))
  } catch (error) {
    locations.set(cacheKey, null)
    log.warn(
      'Unable to resolve a location in the source map for %s: %s',
      fileName,
      getErrorMessage(error)
    )
    return
  }

  let original = null
  if (entry?.originalSource !== undefined &&
      entry.originalLine !== undefined &&
      entry.originalColumn !== undefined) {
    const originalFileName = toOriginalFileName(entry.originalSource)
    const originalLineNumber = entry.originalLine + 1
    const originalColumnNumber = entry.originalColumn + 1
    original = {
      fileName: originalFileName,
      lineNumber: originalLineNumber,
      columnNumber: originalColumnNumber,
      formatted: `${originalFileName}:${originalLineNumber}:${originalColumnNumber}`,
      sourceMap,
    }
  }

  locations.set(cacheKey, original)
  return original ?? undefined
}

/**
 * CommonJS source maps are keyed by their module object so deleting and reloading a module cannot
 * reuse a stale map. ESM URLs are immutable, so a bounded URL cache is safe for those entries.
 *
 * @param {string} fileName
 * @param {boolean} cacheByURL
 * @returns {import('node:module').SourceMap | null}
 */
function getSourceMap (fileName, cacheByURL) {
  if (fileName.startsWith('node:')) return null

  const cachedModule = require.cache[fileName]
  if (cachedModule !== undefined) {
    const cached = sourceMapByModule.get(cachedModule)
    if (cached !== undefined) return cached

    const sourceMap = loadSourceMap(fileName)
    sourceMapByModule.set(cachedModule, sourceMap)
    return sourceMap
  }

  if (cacheByURL && fileName.startsWith('file:')) {
    const cached = sourceMapByURL.get(fileName)
    if (cached !== undefined) return cached

    const sourceMap = loadSourceMap(fileName)
    if (sourceMapByURL.size >= SOURCE_MAP_URL_CACHE_LIMIT) {
      const oldestFileName = sourceMapByURL.keys().next().value
      if (oldestFileName !== undefined) sourceMapByURL.delete(oldestFileName)
    }
    sourceMapByURL.set(fileName, sourceMap)
    return sourceMap
  }

  // A CommonJS module that throws while loading is absent from `require.cache`. Avoid retaining a
  // filename-keyed result: a later load of the same file may register a different source map.
  return loadSourceMap(fileName)
}

/**
 * @param {string} fileName
 * @returns {import('node:module').SourceMap | null}
 */
function loadSourceMap (fileName) {
  try {
    return findSourceMap(fileName) ?? null
  } catch (error) {
    log.warn(
      'Unable to load the source map for %s: %s',
      fileName,
      getErrorMessage(error)
    )
    return null
  }
}

/**
 * @param {string} source
 * @returns {string}
 */
function toOriginalFileName (source) {
  if (!source.startsWith('file:')) return source

  try {
    return fileURLToPath(source)
  } catch (error) {
    log.warn(
      'Unable to convert source map URL %s to a path: %s',
      source,
      getErrorMessage(error)
    )
    return source
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage (error) {
  try {
    return String(error instanceof Error ? error.message : error)
  } catch {
    return 'Unknown error'
  }
}

/**
 * Wrap a call site so custom formatters see the original source location while every other method
 * still runs against the real V8 call site.
 *
 * @param {NodeJS.CallSite} callSite
 * @param {number} index
 * @param {NodeJS.CallSite[]} callSites
 * @returns {NodeJS.CallSite}
 */
function toOriginalCallSite (callSite, index, callSites) {
  const generatedFileName = callSite.getFileName()
  const fileName = generatedFileName ??
    (generatedCodeEnabled ? callSite.getEvalOrigin?.() : undefined)
  const original = resolveLocation(
    fileName,
    callSite.getLineNumber(),
    callSite.getColumnNumber(),
    generatedFileName !== undefined && generatedFileName !== null
  )
  if (original === undefined) return callSite

  const callerCallSite = callSites[index + 1]
  return new Proxy(callSite, {
    /**
     * @param {NodeJS.CallSite} target
     * @param {string | symbol} property
     * @returns {unknown}
     */
    get (target, property) {
      switch (property) {
        case 'getFileName':
        case 'getScriptNameOrSourceURL':
          return () => original.fileName
        case 'getLineNumber':
          return () => original.lineNumber
        case 'getColumnNumber':
          return () => original.columnNumber
        case 'toString':
          return () => formatCallSite(target, original, callerCallSite)
        default: {
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      }
    },
  })
}

module.exports = {
  enable,
  isNativeSourceMapSupportEnabled,
  syncSourceMapSupport,
}
