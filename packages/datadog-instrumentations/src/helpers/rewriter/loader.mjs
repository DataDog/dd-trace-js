import * as Module from 'module'

const require = Module.createRequire(import.meta.url)
const { getFormat, loadSync, rewriteResult } = require('./hooks.js')

async function load (url, context, nextLoad) {
  const result = await nextLoad(url, context)
  const format = getFormat(result, context)

  // The asynchronous loader cannot supply CommonJS source, so CommonJS keeps
  // being rewritten by the hook the tracer entrypoint installs.
  if (format === 'commonjs') return result

  return rewriteResult(result, url, format)
}

export { load, loadSync }
