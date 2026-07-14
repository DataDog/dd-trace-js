import activation from './activation.js'
import { rewrite } from './index.js'

const { report } = activation

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

  let metadata
  result.source = rewrite(result.source, url, format, transformed => {
    metadata = transformed
    report(transformed)
  })

  if (metadata) {
    // Asynchronous loader hooks can run in an isolated thread whose diagnostic channels are not
    // visible to the application. The dependency reports again in the application realm; same-realm
    // loaders discard that second report through activation's deduplication.
    const activationUrl = new URL('activate.mjs', import.meta.url)
    activationUrl.searchParams.set('name', metadata.name)
    activationUrl.searchParams.set('version', metadata.version)
    activationUrl.searchParams.set('file', metadata.file)
    // Static dependencies evaluate before this module's body regardless of declaration position.
    // Append this import so the transformer's generated source-map line offsets stay unchanged.
    result.source += `\nimport ${JSON.stringify(activationUrl.href)};`
  }

  return result
}

export { load, loadSync }
