'use strict'

const { getRewriteTarget } = require('./targets')
const { createMatcher, getSourceText, getVersion } = require('./index')

/**
 * @typedef {object} Transformer
 * @property {(source: string, moduleType: 'cjs'|'esm', sourceMap?: string|object) =>
 *   { code: string, map?: string|object }} transform
 *
 * @typedef {object} InstrumentationMatcher
 * @property {(moduleName: string, version: string|undefined, filePath: string) => Transformer|undefined} getTransformer
 *
 * @typedef {(content: string|Buffer|ArrayBuffer|Uint8Array, filename: string, format?: string,
 *   target?: { moduleName: string, filePath: string }, sourceMap?: string|object) =>
 *   { code: string|Buffer|ArrayBuffer|Uint8Array, map?: string|object }} BundlerRewriter
 */

/**
 * @param {string} dcModule
 * @returns {BundlerRewriter}
 */
function createBundlerRewriter (dcModule) {
  const matcher = /** @type {InstrumentationMatcher} */ (createMatcher(dcModule))

  return function rewriteBundled (content, filename, format, target, sourceMap) {
    if (!content) return { code: content, map: sourceMap }

    target ||= getRewriteTarget(filename)
    if (!target) return { code: content, map: sourceMap }

    filename = filename.replace('file://', '')

    const moduleType = format === 'module' ? 'esm' : 'cjs'
    const { moduleName, filePath } = target
    const version = getVersion(filename, filePath)
    const transformer = matcher.getTransformer(moduleName, version, filePath)
    if (!transformer) return { code: content, map: sourceMap }

    return transformer.transform(getSourceText(content), moduleType, sourceMap)
  }
}

module.exports = { createBundlerRewriter }
