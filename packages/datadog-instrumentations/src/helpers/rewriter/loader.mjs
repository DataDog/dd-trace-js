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
  result.source = rewrite(result.source, url, context.format)

  return result
}

export { load, loadSync }
