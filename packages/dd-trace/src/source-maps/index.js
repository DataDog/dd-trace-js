'use strict'

const Module = require('node:module')
const path = require('node:path')
const { fileURLToPath, pathToFileURL } = require('node:url')

const { getEnvironmentVariable } = require('../config/helper')
const log = require('../log')
const remap = require('./remap')

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
const { SourceMap } = Module
// eslint-disable-next-line n/no-unsupported-features/node-builtins
const { getSourceMapsSupport, setSourceMapsSupport } =
  /** @type {ProgrammaticSourceMaps} */ (/** @type {unknown} */ (Module))

const supportsProgrammaticSourceMaps = typeof setSourceMapsSupport === 'function'
const legacySourceMapsEnabled = !supportsProgrammaticSourceMaps && isNativeSourceMapSupportEnabled()
const MODE_ALL = 'all'
const MODE_DATADOG = 'datadog'
const MODE_OFF = 'off'
const DIRECT_SOURCE_MAP_CACHE_BYTES_LIMIT = 128 * 1024 * 1024
const DIRECT_SOURCE_MAP_CACHE_LIMIT = 256
const DIRECT_STACK_CACHE_BYTES_LIMIT = 8 * 1024 * 1024
const DIRECT_STACK_CACHE_LIMIT = 1024
const MAX_SOURCE_MAP_BYTES = 64 * 1024 * 1024
const SOURCE_MAPPING_URL_BYTES = 16 * 1024 * 1024
const SOURCE_MAPPING_URL = /^[ \t]*\/\/[#@][ \t]*sourceMappingURL=([^\r\n]+?)[ \t]*$/gm
const SOURCE_MAP_URL_CACHE_LIMIT = 1024
const SOURCE_MAP_LOCATION_CACHE_LIMIT = 4096
const URL_SCHEME = /^[a-z][a-z\d+.-]*:/i
const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/i

/** @type {WeakMap<NodeModule, import('node:module').SourceMap | null>} */
let sourceMapByModule = new WeakMap()
/** @type {Map<string, import('node:module').SourceMap | null>} */
const sourceMapByURL = new Map()
/** @type {WeakMap<import('node:module').SourceMap, Map<string, OriginalLocation | null>>} */
let locationsBySourceMap = new WeakMap()
/** @type {WeakMap<import('node:module').SourceMap, boolean>} */
const sourceMapHasNames = new WeakMap()
/** @type {WeakMap<import('node:module').SourceMap, { directory: string, sourceRoot: string }>} */
const directSourceMapMetadata = new WeakMap()
/**
 * @typedef {object} DirectStackFrameCacheEntry
 * @property {string | undefined} generatedFileName
 * @property {NodeModule | undefined} module
 * @property {string} remappedFrame
 * @property {string | undefined} workingDirectory
 */
/** @type {Map<string, DirectStackFrameCacheEntry>} */
const directStackFrameCache = new Map()
/**
 * @typedef {object} DirectStackCacheDependency
 * @property {string | undefined} generatedFileName
 * @property {NodeModule | undefined} module
 * @property {string | undefined} workingDirectory
 */
/**
 * @typedef {object} DirectStackCacheEntry
 * @property {number} bytes
 * @property {DirectStackCacheDependency[]} dependencies
 * @property {string} remappedFrames
 */
/** @type {Map<string, DirectStackCacheEntry>} */
const directStackCache = new Map()
/**
 * @typedef {object} DirectSourceMapCacheEntry
 * @property {number} bytes
 * @property {NodeModule | undefined} module
 * @property {import('node:module').SourceMap | null} sourceMap
 */
/** @type {Map<string, DirectSourceMapCacheEntry>} */
const directSourceMapByFile = new Map()
/** @type {Map<string, string | null>} */
const generatedFileNameByStackName = new Map()
/** @type {WeakSet<Function>} */
const datadogPrepareStackTraces = new WeakSet()

/** @type {import('./file-system').DirectFileSystem | undefined} */
let directFileSystem
let installed = false
let directSourceMapBytes = 0
let directStackBytes = 0
/** @type {string | undefined} */
let mostRecentDirectSourceMapFileName
let generatedCodeEnabled = legacySourceMapsEnabled
let mode = MODE_OFF
let sourceMapsSupportState = -1
/** @type {Function | undefined} */
let prepareStackTraceAtConfiguration
/** @type {((error: Error, callSites: NodeJS.CallSite[]) => unknown) | undefined} */
let delegatePrepareStackTrace
/** @type {((error: Error, callSites: NodeJS.CallSite[]) => unknown) | undefined} */
let defaultPrepareStackTrace

/**
 * @param {'off' | 'datadog' | 'all'} selectedMode
 * @param {import('./file-system').DirectFileSystem} [fileSystem]
 */
function configure (selectedMode, fileSystem) {
  if (selectedMode === MODE_OFF || mode !== MODE_OFF) return

  const externalSupport = getExternalSourceMapSupport()
  if (externalSupport !== false) return

  prepareStackTraceAtConfiguration = Error.prepareStackTrace
  if (selectedMode === MODE_DATADOG) {
    directFileSystem = fileSystem ?? require('./file-system')()
    mode = MODE_DATADOG
    remap.errorStack = remapErrorStack
    remap.location = remapSourceLocation
  } else if (selectedMode === MODE_ALL) {
    mode = MODE_ALL
    enableAll()
    if (installed) remap.location = remapSourceLocation
  }
}

/**
 * @template Value
 * @param {Value} value
 * @returns {Value}
 */
function identity (value) {
  return value
}

function enableAll () {
  if (!supportsProgrammaticSourceMaps && !legacySourceMapsEnabled) {
    mode = MODE_OFF
    return
  }

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
      mode = MODE_OFF
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
    installed = Error.prepareStackTrace === prepareStackTrace
    if (!installed) mode = MODE_OFF
  } catch (error) {
    defaultPrepareStackTrace = undefined
    delegatePrepareStackTrace = undefined
    log.warn(
      'Unable to install the source map stack trace formatter: %s',
      getErrorMessage(error)
    )
    mode = MODE_OFF
  }
}

/**
 * @param {Function} prepareStackTrace
 * @param {Function | undefined} [delegate]
 */
function registerPrepareStackTrace (prepareStackTrace, delegate) {
  if (delegate === undefined ||
      delegate === prepareStackTraceAtConfiguration ||
      datadogPrepareStackTraces.has(delegate) ||
      isNodeDefaultPrepareStackTrace(delegate)) {
    datadogPrepareStackTraces.add(prepareStackTrace)
  }
}

/**
 * @returns {boolean | undefined}
 */
function getExternalSourceMapSupport () {
  if (isNativeSourceMapSupportEnabled()) return true

  if (supportsProgrammaticSourceMaps) {
    const support = readSourceMapsSupport()
    if (support === undefined) return
    if (support.enabled) return true
  }

  try {
    const prepareStackTrace = Error.prepareStackTrace
    return typeof prepareStackTrace === 'function' &&
      !isNodeDefaultPrepareStackTrace(prepareStackTrace) &&
      !datadogPrepareStackTraces.has(prepareStackTrace)
  } catch (error) {
    log.warn(
      'Unable to read the source map stack trace formatter: %s',
      getErrorMessage(error)
    )
  }
}

/**
 * @returns {SourceMapsSupport | undefined}
 */
function readSourceMapsSupport () {
  try {
    return getSourceMapsSupport()
  } catch (error) {
    log.warn(
      'Unable to read source map support: %s',
      getErrorMessage(error)
    )
  }
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

  const support = readSourceMapsSupport()
  if (support === undefined) return false

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
 * @param {unknown} stack
 * @returns {unknown}
 */
function remapErrorStack (stack) {
  if (typeof stack !== 'string') return stack
  const firstNewline = stack.indexOf('\n')
  if (firstNewline === -1) return stack
  if (shouldDeferDatadogRemapping()) return stack

  const framesStart = firstNewline + 1
  const frames = stack.slice(framesStart)
  const cached = directStackCache.get(frames)
  if (cached !== undefined && useCachedDirectStack(cached)) {
    return cached.remappedFrames === frames
      ? stack
      : stack.slice(0, framesStart) + cached.remappedFrames
  }

  /** @type {DirectStackCacheDependency[]} */
  const dependencies = []
  let output
  let lineStart = 0
  while (lineStart < frames.length) {
    const newline = frames.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? frames.length : newline
    const line = frames.slice(lineStart, lineEnd)
    const remappedLine = remapStackFrame(line)
    const frameEntry = directStackFrameCache.get(line)
    if (frameEntry !== undefined &&
        (frameEntry.generatedFileName !== undefined || frameEntry.workingDirectory !== undefined)) {
      let hasDependency = false
      for (let i = 0; i < dependencies.length; i++) {
        const dependency = dependencies[i]
        if (dependency.generatedFileName === frameEntry.generatedFileName &&
            dependency.workingDirectory === frameEntry.workingDirectory) {
          hasDependency = true
          break
        }
      }
      if (!hasDependency) {
        dependencies.push({
          generatedFileName: frameEntry.generatedFileName,
          module: frameEntry.module,
          workingDirectory: frameEntry.workingDirectory,
        })
      }
    }
    if (remappedLine !== line) {
      output ??= frames.slice(0, lineStart)
      output += remappedLine
    } else if (output !== undefined) {
      output += line
    }
    if (newline === -1) break
    if (output !== undefined) output += '\n'
    lineStart = newline + 1
  }
  const remappedFrames = output ?? frames
  const bytes = (frames.length + (remappedFrames === frames ? 0 : remappedFrames.length)) * 2
  if (cached !== undefined) {
    directStackCache.delete(frames)
    directStackBytes -= cached.bytes
  }
  if (bytes <= DIRECT_STACK_CACHE_BYTES_LIMIT) {
    while (directStackCache.size >= DIRECT_STACK_CACHE_LIMIT ||
           directStackBytes + bytes > DIRECT_STACK_CACHE_BYTES_LIMIT) {
      const [oldestFrames, oldest] = directStackCache.entries().next().value
      directStackCache.delete(oldestFrames)
      directStackBytes -= oldest.bytes
    }
    const entry = { bytes, dependencies, remappedFrames }
    directStackCache.set(frames, entry)
    directStackBytes += bytes
  }
  return output === undefined
    ? stack
    : stack.slice(0, framesStart) + remappedFrames
}

/**
 * @param {DirectStackCacheEntry} entry
 * @returns {boolean}
 */
function useCachedDirectStack (entry) {
  for (let i = 0; i < entry.dependencies.length; i++) {
    const dependency = entry.dependencies[i]
    if (dependency.workingDirectory !== undefined && dependency.workingDirectory !== process.cwd()) return false

    const { generatedFileName } = dependency
    if (generatedFileName !== undefined) {
      if (require.cache[generatedFileName] !== dependency.module) return false
      if (mostRecentDirectSourceMapFileName !== generatedFileName) {
        const sourceMapEntry = directSourceMapByFile.get(generatedFileName)
        if (sourceMapEntry !== undefined) touchDirectSourceMap(generatedFileName, sourceMapEntry)
      }
    }
  }
  return true
}

/**
 * @param {import('./remap').SourceLocation} location
 * @returns {import('./remap').SourceLocation}
 */
function remapSourceLocation (location) {
  if (mode === MODE_DATADOG && shouldDeferDatadogRemapping()) return location
  if (mode === MODE_ALL && !syncSourceMapSupport()) return location

  const original = resolveLocation(location.file, location.line ?? null, location.column ?? null, true)
  if (original === undefined) return location
  return {
    file: original.fileName,
    line: original.lineNumber,
    column: original.columnNumber,
  }
}

function shouldDeferDatadogRemapping () {
  if (mode !== MODE_DATADOG) return true

  try {
    const prepareStackTrace = Error.prepareStackTrace
    if (prepareStackTrace !== prepareStackTraceAtConfiguration &&
        (typeof prepareStackTrace !== 'function' || !datadogPrepareStackTraces.has(prepareStackTrace))) {
      disableDatadogRemapping()
      return true
    }
  } catch (error) {
    log.warn(
      'Unable to read the source map stack trace formatter: %s',
      getErrorMessage(error)
    )
    disableDatadogRemapping()
    return true
  }

  if (supportsProgrammaticSourceMaps) {
    const support = readSourceMapsSupport()
    if (support === undefined || support.enabled) {
      disableDatadogRemapping()
      return true
    }
  }
  return false
}

function disableDatadogRemapping () {
  mode = MODE_OFF
  remap.errorStack = identity
  remap.location = identity
  directStackCache.clear()
  directStackBytes = 0
  directStackFrameCache.clear()
  directSourceMapByFile.clear()
  directSourceMapBytes = 0
  generatedFileNameByStackName.clear()
  mostRecentDirectSourceMapFileName = undefined
  locationsBySourceMap = new WeakMap()
}

/**
 * @param {string} frame
 * @returns {string}
 */
function remapStackFrame (frame) {
  const cached = directStackFrameCache.get(frame)
  if (cached !== undefined &&
      (cached.workingDirectory === undefined || cached.workingDirectory === process.cwd()) &&
      (cached.generatedFileName === undefined || require.cache[cached.generatedFileName] === cached.module)) {
    if (cached.generatedFileName !== undefined && mostRecentDirectSourceMapFileName !== cached.generatedFileName) {
      const sourceMapEntry = directSourceMapByFile.get(cached.generatedFileName)
      if (sourceMapEntry !== undefined) touchDirectSourceMap(cached.generatedFileName, sourceMapEntry)
    }
    return cached.remappedFrame
  }

  let frameEnd = frame.endsWith('\r') ? frame.length - 1 : frame.length
  if (frame.charCodeAt(frameEnd - 1) === 41) frameEnd--

  let lastNumberStart = frameEnd
  while (lastNumberStart > 0 && isDecimalDigit(frame.charCodeAt(lastNumberStart - 1))) lastNumberStart--
  if (lastNumberStart === frameEnd || frame.charCodeAt(lastNumberStart - 1) !== 58) return frame

  const lineEnd = lastNumberStart - 1
  let lineStart = lineEnd
  while (lineStart > 0 && isDecimalDigit(frame.charCodeAt(lineStart - 1))) lineStart--
  let lineNumber
  let columnNumber
  let fileEnd
  if (lineStart !== lineEnd && frame.charCodeAt(lineStart - 1) === 58) {
    lineNumber = Number(frame.slice(lineStart, lineEnd))
    columnNumber = Number(frame.slice(lastNumberStart, frameEnd))
    fileEnd = lineStart - 1
  } else {
    lineNumber = Number(frame.slice(lastNumberStart, frameEnd))
    columnNumber = 1
    fileEnd = lastNumberStart - 1
  }
  if (lineNumber < 1 || columnNumber < 1) return frame

  let atIndex = 0
  while (frame.charCodeAt(atIndex) === 32 || frame.charCodeAt(atIndex) === 9) atIndex++
  if (frame.slice(atIndex, atIndex + 3) !== 'at ') return frame
  const parenthesis = frame.lastIndexOf('(', fileEnd - 1)
  const fileStart = parenthesis > atIndex ? parenthesis + 1 : atIndex + 3
  if (fileStart >= fileEnd) return frame

  const fileName = frame.slice(fileStart, fileEnd)
  const original = resolveLocation(fileName, lineNumber, columnNumber, true)
  const remappedFrame = original === undefined
    ? frame
    : frame.slice(0, fileStart) + original.formatted + frame.slice(frameEnd)
  const generatedFileName = toGeneratedFileName(fileName)
  if (directStackFrameCache.size >= SOURCE_MAP_LOCATION_CACHE_LIMIT) {
    const oldestFrame = directStackFrameCache.keys().next().value
    if (oldestFrame !== undefined) directStackFrameCache.delete(oldestFrame)
  }
  directStackFrameCache.set(frame, {
    generatedFileName,
    module: generatedFileName === undefined ? undefined : require.cache[generatedFileName],
    remappedFrame,
    workingDirectory: path.isAbsolute(fileName) ||
      (URL_SCHEME.test(fileName) && !WINDOWS_DRIVE_PATH.test(fileName))
      ? undefined
      : process.cwd(),
  })
  return remappedFrame
}

/**
 * @param {number} character
 * @returns {boolean}
 */
function isDecimalDigit (character) {
  return character >= 48 && character <= 57
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
  } catch (error) {
    log.debug('Unable to resolve a source map symbol name: %s', getErrorMessage(error))
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
  } catch (error) {
    log.debug('Unable to read source map symbol names: %s', getErrorMessage(error))
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
    const originalFileName = toOriginalFileName(entry.originalSource, sourceMap)
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

  if (locations.size >= SOURCE_MAP_LOCATION_CACHE_LIMIT) locations.clear()
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
  if (mode === MODE_DATADOG) return getDirectSourceMap(fileName)

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
function getDirectSourceMap (fileName) {
  const generatedFileName = toGeneratedFileName(fileName)
  if (generatedFileName === undefined || generatedFileName.includes(`${path.sep}node_modules${path.sep}`)) return null

  const cachedModule = require.cache[generatedFileName]
  const cached = directSourceMapByFile.get(generatedFileName)
  if (cached !== undefined && cached.module === cachedModule) {
    touchDirectSourceMap(generatedFileName, cached)
    return cached.sourceMap
  }
  if (cached !== undefined) {
    directSourceMapByFile.delete(generatedFileName)
    directSourceMapBytes -= cached.bytes
  }

  const loaded = loadDirectSourceMap(generatedFileName)
  const sourceMap = loaded?.sourceMap ?? null
  const bytes = loaded?.bytes ?? 0
  directSourceMapByFile.set(generatedFileName, {
    bytes,
    module: cachedModule,
    sourceMap,
  })
  mostRecentDirectSourceMapFileName = generatedFileName
  directSourceMapBytes += bytes
  evictDirectSourceMaps()
  return sourceMap
}

/**
 * @param {string} fileName
 * @param {DirectSourceMapCacheEntry} entry
 */
function touchDirectSourceMap (fileName, entry) {
  if (mostRecentDirectSourceMapFileName !== fileName) {
    directSourceMapByFile.delete(fileName)
    directSourceMapByFile.set(fileName, entry)
    mostRecentDirectSourceMapFileName = fileName
  }
}

/**
 * @param {string} fileName
 * @returns {string | undefined}
 */
function toGeneratedFileName (fileName) {
  const cacheResult = fileName.startsWith('file:') || path.isAbsolute(fileName)
  if (cacheResult) {
    const cached = generatedFileNameByStackName.get(fileName)
    if (cached !== undefined) return cached ?? undefined
  }

  let generatedFileName
  if (fileName.startsWith('file:')) {
    try {
      generatedFileName = fileURLToPath(fileName)
    } catch (error) {
      log.debug(
        'Unable to convert generated source URL %s to a path: %s',
        fileName,
        getErrorMessage(error)
      )
      generatedFileName = null
    }
  } else if (URL_SCHEME.test(fileName) && !WINDOWS_DRIVE_PATH.test(fileName)) {
    return
  } else {
    generatedFileName = path.resolve(fileName)
  }

  if (cacheResult) {
    if (generatedFileNameByStackName.size >= DIRECT_SOURCE_MAP_CACHE_LIMIT) {
      const oldestStackName = generatedFileNameByStackName.keys().next().value
      if (oldestStackName !== undefined) generatedFileNameByStackName.delete(oldestStackName)
    }
    generatedFileNameByStackName.set(fileName, generatedFileName)
  }
  return generatedFileName ?? undefined
}

function evictDirectSourceMaps () {
  let evicted = false
  while (directSourceMapByFile.size > DIRECT_SOURCE_MAP_CACHE_LIMIT ||
         directSourceMapBytes > DIRECT_SOURCE_MAP_CACHE_BYTES_LIMIT) {
    const [oldestFileName, oldest] = directSourceMapByFile.entries().next().value
    directSourceMapByFile.delete(oldestFileName)
    directSourceMapBytes -= oldest.bytes
    evicted = true
  }
  if (evicted) {
    directStackCache.clear()
    directStackBytes = 0
    directStackFrameCache.clear()
  }
}

/**
 * @param {string} fileName
 * @returns {{ bytes: number, sourceMap: import('node:module').SourceMap } | undefined}
 */
function loadDirectSourceMap (fileName) {
  const fileSystem = directFileSystem

  try {
    const sourceMappingURL = readSourceMappingURL(fileName, fileSystem)
    if (sourceMappingURL === undefined) return

    let bytes
    let directory = path.dirname(fileName)
    if (sourceMappingURL.startsWith('data:')) {
      bytes = decodeInlineSourceMap(sourceMappingURL)
    } else {
      const mapFileName = toSourceMapFileName(sourceMappingURL, directory)
      if (mapFileName === undefined) return
      const size = fileSystem.statSync(mapFileName).size
      if (size > MAX_SOURCE_MAP_BYTES) return
      bytes = fileSystem.readFileSync(mapFileName)
      directory = path.dirname(mapFileName)
    }
    if (bytes === undefined || bytes.length > MAX_SOURCE_MAP_BYTES) return

    const payload = JSON.parse(bytes.toString('utf8'))
    const sourceMap = new SourceMap(payload)
    directSourceMapMetadata.set(sourceMap, {
      directory,
      sourceRoot: typeof payload.sourceRoot === 'string' ? payload.sourceRoot : '',
    })
    return { bytes: bytes.length, sourceMap }
  } catch (error) {
    log.debug(
      'Unable to load the source map for %s: %s',
      fileName,
      getErrorMessage(error)
    )
  }
}

/**
 * @param {string} fileName
 * @param {import('./file-system').DirectFileSystem} fileSystem
 * @returns {string | undefined}
 */
function readSourceMappingURL (fileName, fileSystem) {
  let fileDescriptor
  try {
    fileDescriptor = fileSystem.openSync(fileName, 'r')
    const size = fileSystem.fstatSync(fileDescriptor).size
    const bytesToRead = Math.min(size, SOURCE_MAPPING_URL_BYTES)
    const buffer = Buffer.allocUnsafe(bytesToRead)
    const bytesRead = fileSystem.readSync(fileDescriptor, buffer, 0, bytesToRead, size - bytesToRead)
    const tail = buffer.toString('utf8', 0, bytesRead)
    let match
    let sourceMappingURL
    SOURCE_MAPPING_URL.lastIndex = 0
    while ((match = SOURCE_MAPPING_URL.exec(tail)) !== null) {
      sourceMappingURL = match[1]
    }
    return sourceMappingURL
  } finally {
    if (fileDescriptor !== undefined) fileSystem.closeSync(fileDescriptor)
  }
}

/**
 * @param {string} sourceMappingURL
 * @returns {Buffer | undefined}
 */
function decodeInlineSourceMap (sourceMappingURL) {
  const comma = sourceMappingURL.indexOf(',')
  if (comma === -1) return
  const metadata = sourceMappingURL.slice(5, comma)
  const data = sourceMappingURL.slice(comma + 1)
  return metadata.split(';').includes('base64')
    ? Buffer.from(data, 'base64')
    : Buffer.from(decodeURIComponent(data))
}

/**
 * @param {string} sourceMappingURL
 * @param {string} directory
 * @returns {string | undefined}
 */
function toSourceMapFileName (sourceMappingURL, directory) {
  if (WINDOWS_DRIVE_PATH.test(sourceMappingURL) || sourceMappingURL.startsWith('\\\\')) return sourceMappingURL
  const sourceMapURL = new URL(sourceMappingURL, pathToFileURL(`${directory}${path.sep}`))
  if (sourceMapURL.protocol !== 'file:') return
  sourceMapURL.search = ''
  sourceMapURL.hash = ''
  return fileURLToPath(sourceMapURL)
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
 * @param {import('node:module').SourceMap} sourceMap
 * @returns {string}
 */
function toOriginalFileName (source, sourceMap) {
  const metadata = directSourceMapMetadata.get(sourceMap)
  if (metadata !== undefined && !URL_SCHEME.test(source) && !WINDOWS_DRIVE_PATH.test(source)) {
    const { directory, sourceRoot } = metadata
    if (URL_SCHEME.test(sourceRoot) && !WINDOWS_DRIVE_PATH.test(sourceRoot)) {
      try {
        source = new URL(source, sourceRoot.endsWith('/') ? sourceRoot : `${sourceRoot}/`).href
      } catch (error) {
        log.debug(
          'Unable to resolve original source URL %s: %s',
          source,
          getErrorMessage(error)
        )
      }
    } else {
      source = path.resolve(directory, sourceRoot, source)
    }
  }
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
  configure,
  isNativeSourceMapSupportEnabled,
  registerPrepareStackTrace,
  remapErrorStack,
  syncSourceMapSupport,
}
