import { createRequire } from 'module'
import { fileURLToPath } from 'url'

import { rewrite } from './index.js'

const require = createRequire(import.meta.url)
const cjsSyncHookPath = fileURLToPath(new URL('../cjs-sync-hook.js', import.meta.url))
// Lazily loaded to keep this module importable in environments where the CJS
// helper's dependencies are unavailable (e.g. some bundler graphs).
let cjsSyncHook

// The async loader (module.register, off-thread) cannot own CommonJS export
// wrapping: require-in-the-middle does that on the main thread. So the async
// path keeps rewriting ESM only. The synchronous loader runs on the main thread
// and, when it has taken over from RITM, also handles CommonJS (rewrite +
// export-wrapping shim) — see register.js. `ownsCjs` selects that.
async function load (url, context, nextLoad) {
  const result = await nextLoad(url, context)

  return rewriteResult(result, url, context, false)
}

function loadSync (url, context, nextLoad) {
  const result = nextLoad(url, context)

  return rewriteResult(result, url, context, ownsCjsSync)
}

let ownsCjsSync = false

/**
 * Marks the synchronous loader as the owner of CommonJS instrumentation, so it
 * rewrites CJS source and appends the export-wrapping shim instead of leaving
 * that to RITM + Module._compile. Eagerly loads the CJS helper here (outside the
 * load hook) so the hook never has to `require()` mid-load, which would re-enter
 * the loader on a not-yet-cached module.
 *
 * @param {boolean} value
 * @returns {void}
 */
function setOwnsCjsSync (value) {
  ownsCjsSync = value
  if (value) cjsSyncHook = require(cjsSyncHookPath)
}

function rewriteResult (result, url, context, ownsCjs) {
  const format = result.format || context.format
  const isCjs = format === 'commonjs' || (format === undefined && isRequireConditioned(context))

  if (!isCjs) {
    result.source = rewrite(result.source, url, format)
    return result
  }

  // CommonJS. When the synchronous loader does not own CJS, leave it to
  // Module._compile (rewrite) and RITM (export wrapping).
  if (!ownsCjs) return result

  if (result.source == null) return result

  let source = rewrite(result.source, url, 'commonjs')
  source = appendCjsExportShim(source, url)

  result.source = source
  result.format = 'commonjs'
  return result
}

function isRequireConditioned (context) {
  const conditions = context.conditions
  if (!conditions) return false
  for (let i = 0; i < conditions.length; i++) {
    if (conditions[i] === 'require') return true
  }
  return false
}

/**
 * Appends the export-wrapping shim to an instrumented CommonJS module's source,
 * but only when an `addHook` hook is registered for it. The shim runs after the
 * module evaluates and wraps `module.exports` in place.
 *
 * @param {string} source
 * @param {string} url
 * @returns {string}
 */
function appendCjsExportShim (source, url) {
  if (!cjsSyncHook) return source

  let filename
  try {
    filename = fileURLToPath(url)
  } catch {
    return source
  }

  if (!cjsSyncHook.hasCjsHook(filename)) return source

  const hookPath = JSON.stringify(cjsSyncHookPath)
  const file = JSON.stringify(filename)
  // Reuse the module's own require to load the helper; assign the wrapped result
  // back to module.exports so callers see the instrumented object.
  const shim = `\n;module.exports = require(${hookPath}).applyCjsHooks(module.exports, ${file});\n`
  return source + shim
}

export { load, loadSync, setOwnsCjsSync }
