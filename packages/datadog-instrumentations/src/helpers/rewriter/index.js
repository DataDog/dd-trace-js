'use strict'

const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

const log = require('../../../../dd-trace/src/log')
const { BUNDLER_DC_GLOBAL } = require('../bundler-constants')
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
/** @type {InstrumentationMatcher|undefined} */
let matcherBundler

/**
 * Reuses the process-wide polyfill installed by bundler-register while keeping
 * the native diagnostics channel as the inactive-tracer fallback.
 *
 * @param {{ transforms: { defaults: { tracingChannelImport: Function } } }} state
 * @param {{ body: object[] }} program
 */
function addBundlerTracingChannelImport (state, program) {
  const previousLength = program.body.length
  state.transforms.defaults.tracingChannelImport(state, program)
  if (program.body.length === previousLength) return

  const index = program.body.findIndex(isNativeDcDeclaration)
  const statement = program.body[index]
  const identifier = statement.type === 'ImportDeclaration'
    ? statement.specifiers[0].local
    : statement.declarations[0].id

  identifier.name = 'tr_ch_apm_native_dc'
  program.body.splice(index + 1, 0, createBundlerDcDeclaration())
}

/**
 * @param {object} statement
 * @returns {boolean}
 */
function isNativeDcDeclaration (statement) {
  if (statement.type === 'ImportDeclaration') {
    return statement.source?.value === 'node:diagnostics_channel'
  }
  const declaration = statement.declarations?.[0]
  return declaration?.init?.arguments?.[0]?.value === 'node:diagnostics_channel'
}

/**
 * @returns {object}
 */
function createBundlerDcDeclaration () {
  return {
    type: 'VariableDeclaration',
    declarations: [{
      type: 'VariableDeclarator',
      id: { type: 'Identifier', name: 'tr_ch_apm_dc' },
      init: {
        type: 'LogicalExpression',
        operator: '??',
        left: {
          type: 'MemberExpression',
          computed: true,
          object: { type: 'Identifier', name: 'globalThis' },
          property: {
            type: 'CallExpression',
            arguments: [{ type: 'Literal', value: BUNDLER_DC_GLOBAL }],
            callee: {
              type: 'MemberExpression',
              computed: false,
              object: { type: 'Identifier', name: 'Symbol' },
              property: { type: 'Identifier', name: 'for' },
            },
          },
        },
        right: { type: 'Identifier', name: 'tr_ch_apm_native_dc' },
      },
    }],
    kind: 'const',
  }
}

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
  const { code, map } = rewriteWithMatcher(content, filename, format, target)
  if (!map) return code

  return code + '\n' + SOURCE_MAP_PREFIX + Buffer.from(map).toString('base64')
}

/**
 * Rewrites source with a package specifier that bundlers can include in their
 * output.
 *
 * @param {string|Buffer|ArrayBuffer|Uint8Array} content
 * @param {string} filename
 * @param {string} [format]
 * @param {{ moduleName: string, filePath: string }} [target]
 * @param {string|object} [sourceMap]
 * @returns {{ code: string|Buffer|ArrayBuffer|Uint8Array, map?: string|object }}
 */
function rewriteBundledWithSourceMap (content, filename, format, target, sourceMap) {
  return rewriteWithMatcher(content, filename, format, target, sourceMap, getMatcher('bundler'))
}

/**
 * @param {string|Buffer|ArrayBuffer|Uint8Array} content
 * @param {string} filename
 * @param {string} [format]
 * @param {{ moduleName: string, filePath: string }} [target]
 * @param {string|object} [sourceMap]
 * @param {object} [bundlerMatcher]
 * @returns {{ code: string|Buffer|ArrayBuffer|Uint8Array, map?: string|object }}
 */
function rewriteWithMatcher (content, filename, format, target, sourceMap, bundlerMatcher) {
  if (!content) return { code: content, map: sourceMap }

  target ||= getRewriteTarget(filename)
  if (!target) return { code: content, map: sourceMap }

  filename = filename.replace('file://', '')

  const moduleType = format === 'module' ? 'esm' : 'cjs'
  const { moduleName, filePath } = target
  const version = getVersion(filename, filePath)

  if (disabled.has(moduleName)) return { code: content, map: sourceMap }

  const matcher = bundlerMatcher ?? getMatcher(moduleType)
  const transformer = matcher.getTransformer(moduleName, version, filePath)

  if (!transformer) return { code: content, map: sourceMap }

  try {
    const source = getSourceText(content)
    const { code, map } = transformer.transform(source, moduleType, sourceMap)
    return { code, map }
  } catch (error) {
    log.error(error)
  }

  return { code: content, map: sourceMap }
}

/**
 * @param {'cjs'|'esm'|'bundler'} moduleType
 * @returns {InstrumentationMatcher}
 */
function getMatcher (moduleType) {
  if (moduleType === 'bundler') {
    matcherBundler ??= createMatcher(moduleType)

    return matcherBundler
  }

  if (moduleType === 'esm') {
    matcherEsm ??= createMatcher(moduleType)

    return matcherEsm
  }

  matcherCjs ??= createMatcher(moduleType)

  return matcherCjs
}

/**
 * @param {'cjs'|'esm'|'bundler'} moduleType
 * @returns {InstrumentationMatcher}
 */
function createMatcher (moduleType) {
  const { create } = require('../../../../../vendor/dist/@apm-js-collab/code-transformer')
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

  const dcModule = moduleType === 'bundler' ? 'node:diagnostics_channel' : getDcPolyfillSpecifier(moduleType)
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
  if (moduleType === 'bundler') {
    matcher.addTransform('tracingChannelImport', addBundlerTracingChannelImport)
  }

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

module.exports = { rewrite, rewriteBundledWithSourceMap, disable }
