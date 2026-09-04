'use strict'

const { readFileSync } = require('fs')
const { join } = require('path')
const { pathToFileURL } = require('url')
const log = require('../../../../dd-trace/src/log')
const instrumentations = require('./instrumentations')
const { getRewriteTarget } = require('./targets')

/**
 * @typedef {object} InstrumentationMatcher
 * @property {(name: string, transform: Function) => void} addTransform
 * @property {(moduleName: string, version: string|undefined, filePath: string) => Transformer|undefined} getTransformer
 *
 * @typedef {object} Transformer
 * @property {(source: string, moduleType: 'cjs'|'esm') => { code: string, map?: string }} transform
 */

/**
 * @type {Record<string, string>} map of module base name to version
 */
const moduleVersions = {}
const disabled = new Set()

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
 * @param {string|Buffer|ArrayBuffer|Uint8Array} content
 * @param {string} filename
 * @param {string} [format]
 * @param {{ moduleName: string, filePath: string }} [target]
 * @returns {string|Buffer|ArrayBuffer|Uint8Array}
 */
function rewrite (content, filename, format, target) {
  if (!content) return content

  target ||= getRewriteTarget(filename)
  if (!target) return content

  filename = filename.replace('file://', '')

  const moduleType = format === 'module' ? 'esm' : 'cjs'
  const { moduleName, filePath } = target
  const version = getVersion(filename, filePath)

  if (disabled.has(moduleName)) return content

  const transformer = getMatcher(moduleType).getTransformer(moduleName, version, filePath)

  if (!transformer) return content

  try {
    const source = getSourceText(content)

    // TODO: pass existing sourcemap as input for remapping
    const { code, map } = transformer.transform(source, moduleType)

    if (!map) return code

    const inlineMap = Buffer.from(map).toString('base64')

    return code + '\n' + SOURCE_MAP_PREFIX + inlineMap
  } catch (e) {
    log.error(e)
  }

  return content
}

/**
 * @param {'cjs'|'esm'} moduleType
 * @returns {InstrumentationMatcher}
 */
function getMatcher (moduleType) {
  if (moduleType === 'esm') {
    matcherEsm ??= createMatcher(moduleType)

    return matcherEsm
  }

  matcherCjs ??= createMatcher(moduleType)

  return matcherCjs
}

/**
 * @param {'cjs'|'esm'} moduleType
 * @returns {InstrumentationMatcher}
 */
function createMatcher (moduleType) {
  const { create } = require('../../../../../vendor/dist/@apm-js-collab/code-transformer')
  const {
    awaitContextCallback,
    awaitContextCallbackAtFunctionStart,
    awaitContextCallbackAtTryStart,
    configureGraphqlJitCompileObject,
    configureGraphqlJitDeferredField,
    configureGraphqlJitExecute,
    configureGraphqlJitRuntime,
    configureMercuriusRequest,
    waitForAsyncEnd,
  } = require('./transforms')

  const matcher = create(instrumentations, getDcPolyfillSpecifier(moduleType))

  matcher.addTransform('awaitContextCallback', awaitContextCallback)
  matcher.addTransform('awaitContextCallbackAtFunctionStart', awaitContextCallbackAtFunctionStart)
  matcher.addTransform('awaitContextCallbackAtTryStart', awaitContextCallbackAtTryStart)
  matcher.addTransform('waitForAsyncEnd', waitForAsyncEnd)
  matcher.addTransform('configureGraphqlJitCompileObject', configureGraphqlJitCompileObject)
  matcher.addTransform('configureGraphqlJitDeferredField', configureGraphqlJitDeferredField)
  matcher.addTransform('configureGraphqlJitExecute', configureGraphqlJitExecute)
  matcher.addTransform('configureGraphqlJitRuntime', configureGraphqlJitRuntime)
  matcher.addTransform('configureMercuriusRequest', configureMercuriusRequest)

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
 * @returns {string}
 */
function getSourceText (source) {
  if (typeof source === 'string') return source
  if (ArrayBuffer.isView(source)) {
    return Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString('utf8')
  }
  return Buffer.from(source).toString('utf8')
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

module.exports = { rewrite, disable }
