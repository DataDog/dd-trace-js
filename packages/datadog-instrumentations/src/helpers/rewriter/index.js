'use strict'

const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { fileURLToPath, pathToFileURL } = require('node:url')

const log = require('../../../../dd-trace/src/log')
const { getDisabledInstrumentations } = require('../instrumentation-utils')
const instrumentations = require('./instrumentations')
const { getRewriteTarget } = require('./targets')

/**
 * @typedef {object} InstrumentationMatcher
 * @property {(name: string, transform: Function) => void} addTransform
 * @property {(moduleName: string, version: string|undefined, filePath: string) => Transformer|undefined} getTransformer
 *
 * @typedef {object} Transformer
 * @property {(source: string, moduleType: 'cjs'|'esm', sourceMap?: string|object) =>
 *   { code: string, map?: string|object }} transform
 *
 * @typedef {(content: string|Buffer|ArrayBuffer|Uint8Array, filename: string, format?: string,
 *   target?: { moduleName: string, filePath: string }, sourceMap?: string|object) =>
 *   { code: string|Buffer|ArrayBuffer|Uint8Array, map?: string|object }} BundlerRewriter
 */

/**
 * @type {Record<string, string>} map of module base name to version
 */
const moduleVersions = {}
// Asynchronous loader workers have their own module graph and cannot receive disable() calls made on the main thread.
const disabled = getDisabledInstrumentations()

// Matchers are built on the first module that actually needs rewriting. The
// vendored transformer is a quarter megabyte of bundle that an application
// without a rewrite target never needs to parse, and an application that loads
// targets of only one module type never needs the other matcher.
/** @type {InstrumentationMatcher|undefined} */
let matcherCjs
/** @type {InstrumentationMatcher|undefined} */
let matcherEsm

// Keep the marker split: source-map scanners can read a contiguous token in
// string literals as this file's own inline map.
// eslint-disable-next-line unicorn/no-useless-concat -- Keep the source-map marker non-contiguous.
const SOURCE_MAP_PREFIX = '//# sourceMapping' + 'URL=data:application/json;base64,'

/**
 * Loader hooks hand `file://` URLs to the rewriter while CommonJS and bundler
 * callers pass plain paths. `fileURLToPath` is the only correct conversion: a
 * plain scheme strip leaves Windows paths rooted at `/C:/` and keeps
 * percent-encoded characters undecoded, which breaks version resolution.
 * Rewrite-target paths use forward slashes, including on Windows.
 *
 * @param {string} filename
 */
function normalizeFilename (filename) {
  const path = filename.startsWith('file://') ? fileURLToPath(filename) : filename
  return path.replaceAll('\\', '/')
}

/**
 * @param {string|Buffer|ArrayBuffer|Uint8Array} content
 * @param {string} filename
 * @param {string} [format]
 * @param {{ moduleName: string, filePath: string }} [target]
 * @returns {string|Buffer|ArrayBuffer|Uint8Array}
 */
function rewrite (content, filename, format, target) {
  if (!content) return content

  try {
    filename = normalizeFilename(filename)
    target ||= getRewriteTarget(filename)
    if (!target) return content

    const moduleType = format === 'module' ? 'esm' : 'cjs'
    const { moduleName, filePath } = target
    if (disabled.has(moduleName)) return content

    const version = getVersion(filename, filePath)
    if (!version) return content

    const transformer = getMatcher(moduleType).getTransformer(moduleName, version, filePath)

    if (!transformer) return content

    const source = getSourceText(content)

    // TODO: pass existing sourcemap as input for remapping
    let { code, map } = transformer.transform(source, moduleType)

    if (source.startsWith('#!') && !code.startsWith('#!')) {
      // A shebang must be the entire first line, and JavaScript recognizes
      // exactly four line terminators: \n, \r, \u2028 (line separator), and
      // \u2029 (paragraph separator). Any of the four can end the shebang line.
      const shebangEnd = source.search(/[\r\n\u2028\u2029]/)
      code = (shebangEnd === -1 ? source : source.slice(0, shebangEnd)) + '\n' + code
      map = shiftSourceMapLine(map)
    }

    if (!map) return code

    const inlineMap = Buffer.from(typeof map === 'string' ? map : JSON.stringify(map)).toString('base64')

    return code + '\n' + SOURCE_MAP_PREFIX + inlineMap
  } catch (e) {
    log.error(e)
  }

  return content
}

/**
 * @param {string} dcModule
 * @returns {BundlerRewriter}
 */
function createBundlerRewriter (dcModule) {
  const matcher = createMatcher(dcModule)

  return function rewriteBundled (content, filename, format, target, sourceMap) {
    if (!content) return { code: content, map: sourceMap }

    try {
      filename = normalizeFilename(filename)
      target ||= getRewriteTarget(filename)
      if (!target) return { code: content, map: sourceMap }

      const moduleType = format === 'module' ? 'esm' : 'cjs'
      const { moduleName, filePath } = target
      const version = getVersion(filename, filePath)
      if (!version) return { code: content, map: sourceMap }

      const transformer = matcher.getTransformer(moduleName, version, filePath)
      if (!transformer) return { code: content, map: sourceMap }

      return transformer.transform(getSourceText(content), moduleType, sourceMap)
    } catch (error) {
      log.error(error)
      return { code: content, map: sourceMap }
    }
  }
}

/**
 * @param {'cjs'|'esm'} moduleType
 * @returns {InstrumentationMatcher}
 */
function getMatcher (moduleType) {
  if (moduleType === 'esm') {
    matcherEsm ??= createMatcher(getDcPolyfillSpecifier(moduleType))

    return matcherEsm
  }

  matcherCjs ??= createMatcher(getDcPolyfillSpecifier(moduleType))

  return matcherCjs
}

/**
 * @param {string|undefined} dcModule
 * @returns {InstrumentationMatcher}
 */
function createMatcher (dcModule) {
  const { create } = require('../../../../../vendor/dist/@apm-js-collab/code-transformer')
  const {
    awaitContextCallback,
    configureGraphqlFastPath,
    configureGraphqlJitCompileObject,
    configureGraphqlJitDeferredField,
    configureGraphqlJitExecute,
    configureGraphqlJitRuntime,
    configureMercuriusRequest,
    publishDurableOrchestrationFailure,
    waitForAsyncEnd,
  } = require('./transforms')
  const {
    postgresQueryHandlers,
    postgresQueryLifecycle,
    postgresQueryPreparation,
  } = require('./transforms/postgres')

  const matcher = create(instrumentations, dcModule)

  matcher.addTransform('awaitContextCallback', awaitContextCallback)
  matcher.addTransform('waitForAsyncEnd', waitForAsyncEnd)
  matcher.addTransform('configureGraphqlFastPath', configureGraphqlFastPath)
  matcher.addTransform('configureGraphqlJitCompileObject', configureGraphqlJitCompileObject)
  matcher.addTransform('configureGraphqlJitDeferredField', configureGraphqlJitDeferredField)
  matcher.addTransform('configureGraphqlJitExecute', configureGraphqlJitExecute)
  matcher.addTransform('configureGraphqlJitRuntime', configureGraphqlJitRuntime)
  matcher.addTransform('configureMercuriusRequest', configureMercuriusRequest)
  matcher.addTransform('publishDurableOrchestrationFailure', publishDurableOrchestrationFailure)
  matcher.addTransform('postgresQueryHandlers', postgresQueryHandlers)
  matcher.addTransform('postgresQueryLifecycle', postgresQueryLifecycle)
  matcher.addTransform('postgresQueryPreparation', postgresQueryPreparation)

  return matcher
}

/**
 * `dc-polyfill` is referenced from injected `require()` (CJS) and `import`
 * (ESM) statements that the transformer splices into the rewritten module.
 * `require()` accepts an absolute filesystem path; the ESM resolver rejects it
 * with `ERR_INVALID_MODULE_SPECIFIER` and needs a `file://` URL instead. Each
 * matcher therefore hands the transformer the form that is valid for the
 * module type it is rewriting.
 *
 * @param {'cjs'|'esm'} moduleType
 * @returns {string|undefined} `undefined` when `dc-polyfill` cannot be resolved
 */
function getDcPolyfillSpecifier (moduleType) {
  try {
    const resolved = require.resolve('dc-polyfill')

    return moduleType === 'esm' ? pathToFileURL(resolved).href : resolved.replaceAll('\\', '/')
  } catch {
    // The `dc-polyfill` module is unavailable for some reason (like bundling).
    // Let's just keep the default of using `diagnostics-channel` as a fallback
    // which works for most Node versions.
  }
}

/** @typedef {{ buffer: ArrayBuffer | SharedArrayBuffer, byteLength: number, byteOffset: number }} BufferView */

/**
 * Convert the source representations accepted by Node.js loader hooks to text.
 *
 * @param {string | ArrayBuffer | BufferView} source
 */
function getSourceText (source) {
  if (typeof source === 'string') return source
  if (ArrayBuffer.isView(source)) {
    return Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString('utf8')
  }
  return Buffer.from(source).toString('utf8')
}

/**
 * Account for a shebang restored ahead of the generated program. The transformer already maps original positions
 * past the input shebang, so only the generated side needs an additional empty line.
 *
 * @param {string|object|undefined} map
 */
function shiftSourceMapLine (map) {
  if (!map) return map
  const sourceMap = typeof map === 'string' ? JSON.parse(map) : map
  const shifted = { ...sourceMap, mappings: `;${sourceMap.mappings}` }
  return typeof map === 'string' ? JSON.stringify(shifted) : shifted
}

function disable (instrumentation) {
  disabled.add(instrumentation)
}

function getVersion (filename, filePath) {
  const [basename] = filename.split(filePath)

  if (!moduleVersions[basename]) {
    try {
      const pkg = JSON.parse(readFileSync(
        join(basename, 'package.json'), 'utf8'
      ))

      moduleVersions[basename] = pkg.version
    } catch {}
  }

  return moduleVersions[basename]
}

module.exports = { createBundlerRewriter, disable, rewrite }
