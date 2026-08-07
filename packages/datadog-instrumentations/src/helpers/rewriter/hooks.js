'use strict'

const { fileURLToPath } = require('node:url')

const { getRewriteTarget } = require('./targets.js')

const rewrittenForCompileSymbol = Symbol.for('dd-trace.loader.rewritten-for-compile')

let rewriter

/**
 * Synchronous Node.js load hook. Shared by the full synchronous loader installed
 * from `register.js` and by the CommonJS-only hook installed from the tracer
 * entrypoint, so both rewrite through exactly one implementation.
 *
 * @param {string} url
 * @param {{ format?: string, conditions?: string[] }} context
 * @param {(url: string, context: object) => { format?: string, source?: unknown }} nextLoad
 * @returns {{ format?: string, source?: unknown }}
 */
function loadSync (url, context, nextLoad) {
  const result = nextLoad(url, context)
  const format = getFormat(result, context)

  return rewriteSyncResult(result, url, format, context.conditions)
}

/**
 * @param {{ format?: string, source?: unknown }} result
 * @param {string} url
 * @param {string|undefined} format
 * @param {string[]|undefined} conditions
 * @returns {{ format?: string, source?: unknown }}
 */
function rewriteSyncResult (result, url, format, conditions) {
  const source = result.source

  rewriteResult(result, url, format)

  if (
    result.source !== source &&
    (format === 'commonjs' || hasRequireCondition(conditions)) &&
    url.startsWith('file:')
  ) {
    const rewrittenForCompile = globalThis[rewrittenForCompileSymbol] ??= new Set()
    rewrittenForCompile.add(fileURLToPath(url))
  }

  return result
}

/**
 * @param {{ format?: string, source?: unknown }} result
 * @param {string} url
 * @param {string|undefined} format
 * @returns {{ format?: string, source?: unknown }}
 */
function rewriteResult (result, url, format) {
  const target = getRewriteTarget(url)
  if (!target) return result

  const source = result.source
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

module.exports = { getFormat, hasRequireCondition, loadSync, rewriteResult, rewriteSyncResult }
