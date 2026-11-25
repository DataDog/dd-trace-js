import * as Module from 'module'

const require = Module.createRequire(import.meta.url)
const { addRewriteMarker } = require('./rewrite-marker.js')
const { getRewriteTarget } = require('./targets.js')
let rewriter

async function load (url, context, nextLoad) {
  const result = await nextLoad(url, context)

  return rewriteResult(result, url, context, true)
}

function loadSync (url, context, nextLoad) {
  const result = nextLoad(url, context)

  return rewriteResult(result, url, context)
}

/**
 * @param {{ format?: string, source?: unknown }} result
 * @param {string} url
 * @param {{ format?: string }} context
 * @param {boolean} [markSource] Mark async rewrites so the scoped hook does not repeat them.
 */
function rewriteResult (result, url, context, markSource) {
  const format = result.format || context.format

  // CommonJS source is rewritten by Module._compile. Rewriting it here too
  // double-instruments CommonJS entrypoints loaded through sync hooks.
  if (format === 'commonjs') return result

  if (result.source) {
    const target = getRewriteTarget(url)
    if (target) {
      if (!rewriter) {
        rewriter = require('./index.js')
      }

      const source = rewriter.rewrite(result.source, url, format, target)
      result.source = markSource && format === 'module' && typeof source === 'string' && source !== result.source
        ? addRewriteMarker(source)
        : source
    }
  }

  return result
}

export { load, loadSync }
