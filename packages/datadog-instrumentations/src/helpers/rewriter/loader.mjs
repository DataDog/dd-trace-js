import * as Module from 'module'

const require = Module.createRequire(import.meta.url)
const { getRewriteTarget } = require('./targets.js')
let rewriter

async function load (url, context, nextLoad) {
  const result = await nextLoad(url, context)
  const format = getFormat(result, context)

  // The asynchronous loader keeps using Module._compile for CommonJS until all
  // supported runtimes can use synchronous hooks.
  if (format === 'commonjs') return result

  return rewriteResult(result, url, format)
}

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
  const { source } = result
  let hashbang

  if (format === 'commonjs' && typeof source === 'string' && source.startsWith('#!')) {
    hashbang = source.split('\n', 1)[0]
  }

  if (source) {
    const target = getRewriteTarget(url)
    if (target) {
      if (!rewriter) {
        rewriter = require('./index.js')
      }

      const rewrittenSource = rewriter.rewrite(source, url, format, target)

      // The CommonJS compiler used to receive Orchestrion output after Node had
      // handled the hashbang. The synchronous load hook must restore it itself.
      result.source = hashbang && typeof rewrittenSource === 'string' && !rewrittenSource.startsWith('#!')
        ? `${hashbang}\n${rewrittenSource}`
        : rewrittenSource
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

  const { conditions } = context
  if (!conditions) return

  for (let i = 0; i < conditions.length; i++) {
    if (conditions[i] === 'require') return 'commonjs'
  }
}

export { load, loadSync }
