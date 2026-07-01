import { rewrite } from './index.js'

async function load (url, context, nextLoad) {
  const result = await nextLoad(url, context)

  return rewriteResult(result, url, context)
}

function loadSync (url, context, nextLoad) {
  const result = nextLoad(url, context)

  return rewriteResult(result, url, context)
}

function rewriteResult (result, url, context) {
  const format = result.format || context.format

  // CommonJS source is rewritten by Module._compile. Rewriting it here too
  // double-instruments CommonJS entrypoints loaded through sync hooks.
  if (format === 'commonjs') return result

  result.source = rewrite(result.source, url, format)

  return result
}

export { load, loadSync }
