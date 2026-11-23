import * as Module from 'module'

const require = Module.createRequire(import.meta.url)
const { loadSync, rewriteLoadResult } = require('./module-hooks.js')

async function load (url, context, nextLoad) {
  const result = await nextLoad(url, context)

  // CommonJS source is rewritten by Module._compile. Rewriting it here too
  // double-instruments CommonJS entrypoints loaded through the loader.
  if ((result.format || context.format) === 'commonjs') return result

  return rewriteLoadResult(result, url, context)
}

export { load, loadSync }
