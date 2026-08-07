'use strict'

const { getRewriteTarget } = require('./targets.js')

let rewriter

/**
 * Synchronous Node.js load hook. Shared by the full synchronous loader installed
 * from `register.js` and by the CommonJS-only hook installed from the tracer
 * entrypoint, so both rewrite through exactly one implementation.
 *
 * @param {string} url
 * @param {{ format?: string, conditions?: string[] }} context
 * @param {(url: string, context: object, onSource?: (source: unknown) => void) =>
 *   { format?: string, source?: unknown }} nextLoad
 */
function loadSync (url, context, nextLoad) {
  // Only a rewrite target ever needs the discarded source below, so nothing is
  // allocated for the modules that make up almost every load.
  if (!getRewriteTarget(url)) return nextLoad(url, context)

  // import-in-the-middle clears the source of a CommonJS module it pulls into its
  // ESM graph, so that Node loads it through its native CommonJS loader and
  // require()s of `module-sync` packages inside it keep working. That leaves this
  // hook nothing to rewrite, so the loader hands back the source it read before
  // clearing it.
  let discardedSource
  const result = nextLoad(url, context, source => { discardedSource = source })

  return rewriteResult(result, url, getFormat(result, context), discardedSource)
}

/**
 * @param {{ format?: string, source?: unknown }} result
 * @param {string} url
 * @param {string|undefined} format
 * @param {unknown} [discardedSource] Source a preceding loader read and then dropped.
 */
function rewriteResult (result, url, format, discardedSource) {
  const target = getRewriteTarget(url)
  if (!target) return result

  const source = result.source ?? discardedSource
  if (!source) return result

  if (!rewriter) {
    rewriter = require('./index.js')
  }

  result.source = rewriter.rewrite(source, url, format, target)

  return result
}

/**
 * @param {{ format?: string }} result
 * @param {{ format?: string, conditions?: string[] }} context
 * @returns {string|undefined}
 */
function getFormat (result, context) {
  const format = result.format || context.format
  if (format) return format

  // Synchronous hooks report a require() dependency load with a `require`
  // condition but no format. A present format is authoritative instead: ESM
  // loaded through require() reports `format: 'module'` and still needs rewrite.
  if (hasRequireCondition(context.conditions)) return 'commonjs'
}

/**
 * Whether the load came from `require()` rather than `import`. Node reports the
 * `require` condition for every require() load, including the CommonJS
 * entrypoint and ESM pulled in through require(esm).
 *
 * @param {string[]|undefined} conditions
 * @returns {boolean}
 */
function hasRequireCondition (conditions) {
  if (!conditions) return false

  for (let i = 0; i < conditions.length; i++) {
    if (conditions[i] === 'require') return true
  }

  return false
}

module.exports = { getFormat, hasRequireCondition, loadSync, rewriteResult }
