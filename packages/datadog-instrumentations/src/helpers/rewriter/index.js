'use strict'

const { readFileSync } = require('fs')
const { join } = require('path')
const { pathToFileURL } = require('url')
const log = require('../../../../dd-trace/src/log')
const { create } = require('../../../../../vendor/dist/@apm-js-collab/code-transformer')
const { waitForAsyncEnd } = require('./transforms')
const instrumentations = require('./instrumentations')

// `dc-polyfill` is referenced from injected `require()` (CJS) and `import`
// (ESM) statements that the transformer splices into the rewritten module.
// `require()` accepts an absolute filesystem path; the ESM resolver rejects it
// with `ERR_INVALID_MODULE_SPECIFIER` and needs a `file://` URL instead. We
// pre-compute both forms here so each matcher hands the transformer a
// specifier that is valid for the module type it is rewriting.
let dcPolyfillCjs
let dcPolyfillEsm

try {
  const resolved = require.resolve('dc-polyfill')
  dcPolyfillCjs = resolved.replaceAll('\\', '/')
  dcPolyfillEsm = pathToFileURL(resolved).href
} catch {
  // The `dc-polyfill` module is unavailable for some reason (like bundling).
  // Let's just keep the default of using `diagnostics-channel` as a fallback
  // which works for most Node versions.
}

/** @type {Record<string, string>} map of module base name to version */
const moduleVersions = {}
const disabled = new Set()
const matcherCjs = create(instrumentations, dcPolyfillCjs)
const matcherEsm = create(instrumentations, dcPolyfillEsm)

for (const matcher of [matcherCjs, matcherEsm]) {
  matcher.addTransform('waitForAsyncEnd', waitForAsyncEnd)
}

// Keep the marker split: source-map scanners can read a contiguous token in
// string literals as this file's own inline map.
const SOURCE_MAP_PREFIX = '//# sourceMapping' + 'URL=data:application/json;base64,'

/**
 * Rewrites a matching module and optionally reports successful transformation metadata.
 *
 * @param {string|Buffer} content
 * @param {string} filename
 * @param {string} format
 * @param {(metadata: { name: string, version: string, file: string }) => void} [onTransformation]
 * @returns {string|Buffer}
 */
function rewrite (content, filename, format, onTransformation) {
  if (!content) return content
  if (!filename.includes('node_modules')) return content

  filename = filename.replace('file://', '')

  const moduleType = format === 'module' ? 'esm' : 'cjs'
  const [modulePath] = filename.split('/node_modules/').reverse()
  const moduleParts = modulePath.split('/')
  const splitIndex = moduleParts[0].startsWith('@') ? 2 : 1
  const moduleName = moduleParts.slice(0, splitIndex).join('/')
  const filePath = moduleParts.slice(splitIndex).join('/')
  const version = getVersion(filename, filePath)

  if (disabled.has(moduleName)) return content

  const matcher = moduleType === 'esm' ? matcherEsm : matcherCjs
  const transformer = matcher.getTransformer(moduleName, version, filePath)

  if (!transformer) return content

  try {
    // TODO: pass existing sourcemap as input for remapping
    const { code, map } = transformer.transform(content, moduleType)
    const rewritten = map
      ? code + '\n' + SOURCE_MAP_PREFIX + Buffer.from(map).toString('base64')
      : code

    onTransformation?.({ name: moduleName, version, file: filePath })

    return rewritten
  } catch (e) {
    log.error(e)
  }

  return content
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
