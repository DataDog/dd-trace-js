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
 * @param {(url: string, context: object) => { format?: string, source?: unknown }} nextLoad
 */
function loadSync (url, context, nextLoad) {
  const result = nextLoad(url, context)

  return rewriteResult(result, url, getFormat(result, context))
}

/**
 * @param {{ format?: string, source?: unknown }} result
 * @param {string} url
 * @param {string|undefined} format
 */
function rewriteResult (result, url, format) {
  if (result.source) {
    const target = getRewriteTarget(url)
    if (target) {
      if (!rewriter) {
        rewriter = require('./index.js')
      }

      // Orchestrion drops a leading hashbang and emits the same number of lines
      // either way, so restoring it here would shift every source map mapping by
      // one line. Neither compiler needs it: Node accepts CommonJS and ESM source
      // without a hashbang.
      result.source = rewriter.rewrite(result.source, url, format, target)
    }
  }

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
  const { conditions } = context
  if (!conditions) return

  for (let i = 0; i < conditions.length; i++) {
    if (conditions[i] === 'require') return 'commonjs'
  }
}

module.exports = { getFormat, loadSync, rewriteResult }
