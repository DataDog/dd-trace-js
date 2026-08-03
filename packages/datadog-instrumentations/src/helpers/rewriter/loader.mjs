import * as Module from 'module'

const require = Module.createRequire(import.meta.url)
const { getRewriteTarget } = require('./targets.js')
let rewriter

async function load (url, context, nextLoad) {
  const result = await nextLoad(url, context)

  return rewriteResult(result, url, context)
}

function loadSync (url, context, nextLoad) {
  const result = nextLoad(url, context)

  return rewriteResult(result, url, context)
}

/**
 * @param {{ format?: string, source?: unknown }} result
 * @param {string} url
 * @param {{ format?: string }} context
 */
function rewriteResult (result, url, context) {
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

      result.source = rewriter.rewrite(result.source, url, format, target)
    }
  }

  return result
}

export { load, loadSync }
