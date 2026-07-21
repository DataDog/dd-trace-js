import { rewrite } from './index.js'

async function load (url, context, nextLoad) {
  const result = await nextLoad(url, context)
  const format = result.format || context.format

  // The asynchronous loader keeps using Module._compile for CommonJS until all
  // supported runtimes can use synchronous hooks.
  if (format === 'commonjs') return result

  return rewriteResult(result, url, context)
}

function loadSync (url, context, nextLoad) {
  const result = nextLoad(url, context)

  return rewriteResult(result, url, context)
}

function rewriteResult (result, url, context) {
  const format = result.format || context.format

  const { source } = result
  let hashbang
  if (format === 'commonjs' && typeof source === 'string' && source.startsWith('#!')) {
    hashbang = source.split('\n', 1)[0]
  }

  const rewrittenSource = rewrite(source, url, format)

  // The CommonJS compiler used to receive Orchestrion output after Node had
  // handled the hashbang. The synchronous load hook must restore it itself.
  result.source = hashbang && typeof rewrittenSource === 'string' && !rewrittenSource.startsWith('#!')
    ? `${hashbang}\n${rewrittenSource}`
    : rewrittenSource

  return result
}

export { load, loadSync }
