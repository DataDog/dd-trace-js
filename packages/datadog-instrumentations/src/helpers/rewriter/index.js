'use strict'

const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

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
 *
 * @typedef {object} CodeTransformer
 * @property {(instrumentations: object, dcModule?: string) => InstrumentationMatcher} create
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
/** @type {Map<string, InstrumentationMatcher>} */
const matcherBundlerByDcModule = new Map()

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

  try {
    const transformer = getMatcher(moduleType).getTransformer(moduleName, version, filePath)
    if (!transformer) return content

    const source = getSourceText(content)
    const { code, map } = transformer.transform(source, moduleType)

    if (!map) return code

    return code + '\n' + SOURCE_MAP_PREFIX + Buffer.from(map).toString('base64')
  } catch (error) {
    log.error(error)
  }

  return content
}

/**
 * @param {string|Buffer|ArrayBuffer|Uint8Array} content
 * @param {string} filename
 * @param {string} [format]
 * @param {{ moduleName: string, filePath: string }} [target]
 * @param {string|object} [sourceMap]
 * @param {string} [dcModule]
 * @returns {{ code: string|Buffer|ArrayBuffer|Uint8Array, map?: string|object }}
 */
function rewriteWithSourceMap (content, filename, format, target, sourceMap, dcModule) {
  if (!content) return { code: content, map: sourceMap }

  target ||= getRewriteTarget(filename)
  if (!target) return { code: content, map: sourceMap }

  filename = filename.replace('file://', '')

  const moduleType = format === 'module' ? 'esm' : 'cjs'
  const { moduleName, filePath } = target
  const version = getVersion(filename, filePath)

  if (disabled.has(moduleName)) return { code: content, map: sourceMap }

  const matcher = getMatcher(moduleType, dcModule)
  const transformer = matcher.getTransformer(moduleName, version, filePath)

  if (!transformer) return { code: content, map: sourceMap }

  const source = getSourceText(content)
  const { code, map } = transformer.transform(source, moduleType, sourceMap)
  return { code, map }
}

/**
 * @param {'cjs'|'esm'} moduleType
 * @param {string} [dcModule]
 * @returns {InstrumentationMatcher}
 */
function getMatcher (moduleType, dcModule) {
  if (dcModule !== undefined) {
    let matcher = matcherBundlerByDcModule.get(dcModule)
    if (matcher === undefined) {
      matcher = createMatcher(moduleType, dcModule)
      matcherBundlerByDcModule.set(dcModule, matcher)
    }

    return matcher
  }

  if (moduleType === 'esm') {
    matcherEsm ??= createMatcher(moduleType)

    return matcherEsm
  }

  matcherCjs ??= createMatcher(moduleType)

  return matcherCjs
}

/**
 * @param {'cjs'|'esm'} moduleType
 * @param {string} [dcModule]
 * @returns {InstrumentationMatcher}
 */
function createMatcher (moduleType, dcModule) {
  const transformer = /** @type {CodeTransformer} */ (
    require('../../../../../vendor/dist/@apm-js-collab/code-transformer')
  )
  const { create } = transformer
  const {
    awaitContextCallback,
    awaitContextCallbackAtFunctionStart,
    awaitContextCallbackAtTryStart,
    configureGraphqlFastPath,
    configureGraphqlJitCompileObject,
    configureGraphqlJitDeferredField,
    configureGraphqlJitExecute,
    configureGraphqlJitRuntime,
    configureMercuriusRequest,
    waitForAsyncEnd,
  } = require('./transforms')

  if (dcModule === undefined) {
    const resolvedDcPolyfill = require.resolve('dc-polyfill')
    dcModule = moduleType === 'esm'
      ? pathToFileURL(resolvedDcPolyfill).href
      : resolvedDcPolyfill.replaceAll('\\', '/')
  }
  const matcher = create(instrumentations, dcModule)

  matcher.addTransform('awaitContextCallback', awaitContextCallback)
  matcher.addTransform('awaitContextCallbackAtFunctionStart', awaitContextCallbackAtFunctionStart)
  matcher.addTransform('awaitContextCallbackAtTryStart', awaitContextCallbackAtTryStart)
  matcher.addTransform('waitForAsyncEnd', waitForAsyncEnd)
  matcher.addTransform('configureGraphqlFastPath', configureGraphqlFastPath)
  matcher.addTransform('configureGraphqlJitCompileObject', configureGraphqlJitCompileObject)
  matcher.addTransform('configureGraphqlJitDeferredField', configureGraphqlJitDeferredField)
  matcher.addTransform('configureGraphqlJitExecute', configureGraphqlJitExecute)
  matcher.addTransform('configureGraphqlJitRuntime', configureGraphqlJitRuntime)
  matcher.addTransform('configureMercuriusRequest', configureMercuriusRequest)
  return matcher
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

module.exports = { rewrite, rewriteWithSourceMap, disable }
