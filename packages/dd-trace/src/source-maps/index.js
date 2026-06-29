'use strict'

// `getSourceMapsSupport` / `setSourceMapsSupport` are guarded by `supportsProgrammaticSourceMaps`
// before every call; they only run on runtimes that expose them.
// eslint-disable-next-line n/no-unsupported-features/node-builtins
const { findSourceMap, getSourceMapsSupport, setSourceMapsSupport } = require('module')
const { fileURLToPath } = require('url')

const { getEnvironmentVariable } = require('../config/helper')

// `module.setSourceMapsSupport()` landed in Node 23.7.0 / 22.14.0. On older runtimes Node's
// source-map cache can only be populated by the `--enable-source-maps` CLI flag, which remaps every
// error eagerly (~2.8x cost). We never impose that flag, but when the user already set it we still
// install our (faster) wrapper to replace Node's eager formatter.
const supportsProgrammaticSourceMaps = typeof setSourceMapsSupport === 'function'

// Node installs its own source-map-aware `Error.prepareStackTrace` (the eager remapper behind
// `--enable-source-maps`) from process start. Captured here so `enable()` can tell it apart from a
// user-provided handler: Node's default is replaced outright (our resolver is the faster one and
// formats from `CallSite` directly), while a real user handler is wrapped so its formatting wins.
const nodeDefaultPrepareStackTrace = typeof Error.prepareStackTrace === 'function' &&
  Error.prepareStackTrace.name === 'ErrorPrepareStackTrace'
  ? Error.prepareStackTrace
  : undefined

// file -> SourceMap | null (null = looked up, no map). Mirrors Node's own cache key, which is the
// resolved filename V8 reports via CallSite#getFileName, so the two never diverge.
const sourceMapByFile = new Map()
// `${file}:${line}:${column}` -> resolved frame string. Repeated identical stacks (the common shape
// on a hot error path) collapse to a single Map lookup after the first resolve.
const resolvedFrameCache = new Map()

let installed = false
// The handler present before `enable()`, restored verbatim on `disable()` for a clean round-trip.
let previousPrepareStackTrace
// The handler `prepareStackTrace` delegates formatting to. Equals `previousPrepareStackTrace`,
// except Node's own default formatter is treated as "none" so our cheaper string path is used.
let delegatePrepareStackTrace

/**
 * Whether this runtime can resolve source maps at all — either programmatically (Node ≥22.14/23.7)
 * or because the process was already started with `--enable-source-maps`. Used by config to decide
 * the default: on where mapping is possible, off otherwise (never impose the eager flag).
 *
 * @returns {boolean}
 */
function isSupported () {
  return supportsProgrammaticSourceMaps || sourceMapsFlagPresent()
}

/**
 * @returns {boolean} Whether `--enable-source-maps` is present in `execArgv` or `NODE_OPTIONS`.
 */
function sourceMapsFlagPresent () {
  return process.execArgv?.includes('--enable-source-maps') ||
    getEnvironmentVariable('NODE_OPTIONS')?.includes('--enable-source-maps') === true
}

/**
 * Enable source-map support and install the stack-trace remapper.
 *
 * The remap happens lazily inside `Error.prepareStackTrace`, i.e. only when an error's `.stack` is
 * actually read, so a thrown-but-uninspected error costs nothing. Must run as early as possible:
 * Node only parses source maps for modules loaded *after* support is enabled.
 *
 * @returns {void}
 */
function enable () {
  if (installed) return

  if (supportsProgrammaticSourceMaps) {
    // `nodeModules: false` keeps dependency frames (which rarely ship maps) off the resolve path;
    // `generatedCode: false` skips `eval`/`new Function`.
    if (getSourceMapsSupport().enabled === false) {
      setSourceMapsSupport(true, { nodeModules: false, generatedCode: false })
    }
  } else if (!sourceMapsFlagPresent()) {
    // Pre-22.14 runtime without the flag: nothing populates the cache, so the wrapper can't resolve
    // anything. Skip install entirely rather than pay for lookups that always miss.
    return
  }

  // Treat Node's own default formatter as "no downstream handler": our string formatter replaces it
  // (same job, lower cost). Only a genuine user handler is delegated to for formatting.
  previousPrepareStackTrace = Error.prepareStackTrace
  delegatePrepareStackTrace = previousPrepareStackTrace === nodeDefaultPrepareStackTrace
    ? undefined
    : previousPrepareStackTrace
  Error.prepareStackTrace = prepareStackTrace
  installed = true
}

/**
 * Restore the previous `Error.prepareStackTrace`. Leaves Node's source-map support enabled, since
 * other consumers (coverage, another tracer) may rely on it and re-disabling drops already-parsed
 * maps.
 *
 * @returns {void}
 */
function disable () {
  if (!installed) return

  // Only restore if nothing else replaced our handler in the meantime.
  if (Error.prepareStackTrace === prepareStackTrace) {
    Error.prepareStackTrace = previousPrepareStackTrace
  }
  previousPrepareStackTrace = undefined
  delegatePrepareStackTrace = undefined
  sourceMapByFile.clear()
  resolvedFrameCache.clear()
  installed = false
}

/**
 * @param {Error} error
 * @param {NodeJS.CallSite[]} callSites
 * @returns {string}
 */
function prepareStackTrace (error, callSites) {
  // A downstream handler (the application's own, or another instrumentation's) owns formatting.
  // Hand it call sites whose location getters report the original source, so the remap is
  // transparent regardless of who renders the stack.
  if (typeof delegatePrepareStackTrace === 'function') {
    return delegatePrepareStackTrace(error, callSites.map(toOriginalCallSite))
  }

  // Match V8's default header byte-for-byte: a missing name reads as `Error`, and the colon and
  // message are dropped when the message is empty. Anything else corrupts the `.stack` of an error
  // someone else captured (e.g. Code Origin parses a header-less dummy and would mis-read
  // `undefined: undefined`).
  const name = error?.name ?? 'Error'
  const message = error?.message ?? ''
  let result = message ? `${name}: ${message}` : name
  for (let i = 0; i < callSites.length; i++) {
    result += `\n    at ${formatCallSite(callSites[i])}`
  }
  return result
}

/**
 * Format a single frame exactly as V8 would, but with the source location rewritten to the original
 * source. The frame text V8 produces (`Object.<anonymous> (file:line:col)`, `Foo.method (…)`, or a
 * bare `file:line:col`) carries naming the `CallSite` getters don't expose verbatim — most notably
 * the `<anonymous>` placeholder and the `Type.method` shape — so the descriptor is taken from
 * `callSite.toString()` and only the trailing `file:line:column` is swapped. Keeping the output
 * byte-identical to V8 matters: downstream consumers (e.g. Code Origin) parse this string.
 *
 * @param {NodeJS.CallSite} callSite
 * @returns {string}
 */
function formatCallSite (callSite) {
  const fileName = callSite.getFileName()
  if (!fileName) return callSite.toString()

  const lineNumber = callSite.getLineNumber()
  const columnNumber = callSite.getColumnNumber()
  const original = resolveLocation(fileName, lineNumber, columnNumber)
  if (original === undefined) return callSite.toString()

  const frame = callSite.toString()
  const generatedLocation = `${fileName}:${lineNumber}:${columnNumber}`
  // The generated location is the trailing segment of the frame, so a single replace from the end
  // rewrites it without disturbing a function name that happens to contain a colon.
  const at = frame.lastIndexOf(generatedLocation)
  return at === -1
    ? frame
    : frame.slice(0, at) + original + frame.slice(at + generatedLocation.length)
}

/**
 * Resolve a generated `file:line:column` to its original `file:line:column` string, or `undefined`
 * when no source map covers it.
 *
 * @param {string} fileName
 * @param {number | null} lineNumber
 * @param {number | null} columnNumber
 * @returns {string | undefined}
 */
function resolveLocation (fileName, lineNumber, columnNumber) {
  const original = resolveOriginalLocation(fileName, lineNumber, columnNumber)
  return original && `${original.fileName}:${original.lineNumber}:${original.columnNumber}`
}

/**
 * Resolve a generated location to its original via the source map covering `fileName`, or
 * `undefined` when none does. Cached per `file:line:column`, so a repeated frame (the common shape
 * on a hot error path) costs a single Map lookup after the first resolve. This is the one place
 * that consults Node's source-map cache; every other consumer (frame formatting, call-site
 * proxying, Code Origin) goes through it.
 *
 * @param {string} fileName
 * @param {number | null} lineNumber 1-indexed.
 * @param {number | null} columnNumber 1-indexed.
 * @returns {OriginalLocation | undefined}
 *
 * @typedef {object} OriginalLocation
 * @property {string} fileName
 * @property {number} lineNumber 1-indexed.
 * @property {number} columnNumber 1-indexed.
 */
function resolveOriginalLocation (fileName, lineNumber, columnNumber) {
  if (!fileName || lineNumber === null) return

  const cacheKey = `${fileName}:${lineNumber}:${columnNumber}`
  const cached = resolvedFrameCache.get(cacheKey)
  if (cached !== undefined) return cached ?? undefined

  const entry = findEntry(fileName, lineNumber, columnNumber)
  let resolved = null
  if (entry?.originalSource !== undefined) {
    resolved = {
      fileName: entry.originalSource.startsWith('file://')
        ? fileURLToPath(entry.originalSource)
        : entry.originalSource,
      lineNumber: entry.originalLine + 1,
      columnNumber: entry.originalColumn + 1,
    }
  }

  resolvedFrameCache.set(cacheKey, resolved)
  return resolved ?? undefined
}

/**
 * Resolve a call site's location to its original source. Returns `undefined` when no source map
 * covers the frame, so callers can fall back to the call site's own (generated) location.
 *
 * @param {NodeJS.CallSite} callSite
 * @returns {OriginalLocation | undefined}
 */
function resolveCallSite (callSite) {
  return resolveOriginalLocation(callSite.getFileName(), callSite.getLineNumber(), callSite.getColumnNumber())
}

/**
 * @param {string} fileName
 * @param {number} lineNumber 1-indexed, as reported by `CallSite#getLineNumber`.
 * @param {number | null} columnNumber 1-indexed, as reported by `CallSite#getColumnNumber`.
 * @returns {SourceMapEntry | undefined}
 *
 * @typedef {object} SourceMapEntry
 * @property {string} [originalSource]
 * @property {number} originalLine 0-indexed.
 * @property {number} originalColumn 0-indexed.
 */
function findEntry (fileName, lineNumber, columnNumber) {
  let sourceMap = sourceMapByFile.get(fileName)
  if (sourceMap === undefined) {
    sourceMap = findSourceMap(fileName) ?? null
    sourceMapByFile.set(fileName, sourceMap)
  }
  if (sourceMap === null) return

  // `findEntry` is 0-indexed; CallSite getters are 1-indexed.
  return sourceMap.findEntry(lineNumber - 1, (columnNumber ?? 1) - 1)
}

/**
 * Wrap a call site so its location getters report the original source while every other method
 * delegates to the real call site. Used when a downstream `prepareStackTrace` formats the stack.
 *
 * @param {NodeJS.CallSite} callSite
 * @returns {NodeJS.CallSite}
 */
function toOriginalCallSite (callSite) {
  const original = resolveCallSite(callSite)
  if (original === undefined) return callSite

  return new Proxy(callSite, {
    get (target, property, receiver) {
      switch (property) {
        case 'getFileName': return () => original.fileName
        case 'getLineNumber': return () => original.lineNumber
        case 'getColumnNumber': return () => original.columnNumber
        default: {
          const value = Reflect.get(target, property, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        }
      }
    },
  })
}

module.exports = {
  enable,
  disable,
  isSupported,
  resolveCallSite,
  // Exposed for tests that need to assert idempotency without reaching into module state.
  _isInstalled: () => installed,
}
