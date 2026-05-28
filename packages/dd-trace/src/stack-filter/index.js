'use strict'

const { ddBasePath, isTrue } = require('../util')

/**
 * @typedef {{
 *   getFileName: () => string | undefined,
 *   isNative: () => boolean,
 *   toString: () => string,
 *   [key: string]: unknown
 * }} CallSite
 *
 * @typedef {(error: Error, callsites: CallSite[]) => unknown} PrepareStackTrace
 */

/** @type {PrepareStackTrace | undefined} */
let priorPrepareStackTrace
let installed = false

// Carriers in this set are excluded from filtering whenever V8 invokes the
// installed `Error.prepareStackTrace`. Membership stays for the carrier's
// lifetime so any `.stack` read returns the unfiltered string, no matter who
// reads it or when.
const bypassSet = new WeakSet()

/**
 * @param {CallSite} callsite
 */
function isDdFrame (callsite) {
  const fileName = callsite.getFileName()
  return typeof fileName === 'string' && fileName.startsWith(ddBasePath)
}

/**
 * @param {CallSite} callsite
 */
function isInternalFrame (callsite) {
  if (callsite.isNative()) return true
  const fileName = callsite.getFileName()
  return fileName == null || fileName.startsWith('node:')
}

/**
 * @param {CallSite} callsite
 */
function isUserFrame (callsite) {
  return !isDdFrame(callsite) && !isInternalFrame(callsite)
}

/**
 * V8's default `Error.prepareStackTrace` shape.
 *
 * @param {Error} error
 * @param {CallSite[]} callsites
 */
function defaultFormatStack (error, callsites) {
  const errorString = Error.prototype.toString.call(error)
  if (callsites.length === 0) return errorString
  return `${errorString}\n    at ${callsites.join('\n    at ')}`
}

/**
 * @param {Error} error
 * @param {CallSite[]} callsites
 */
function chain (error, callsites) {
  return typeof priorPrepareStackTrace === 'function'
    ? priorPrepareStackTrace(error, callsites)
    : defaultFormatStack(error, callsites)
}

/**
 * Drop contiguous dd-trace frames unless they are sandwiched between two user
 * frames. The sandwich check is strict: an internal/native neighbour or
 * end-of-stack on either side drops the run.
 *
 * @param {Error} error
 * @param {CallSite[]} callsites
 */
function ddTraceStackFilter (error, callsites) {
  if (bypassSet.has(error)) return chain(error, callsites)
  if (callsites.length === 0) return chain(error, callsites)
  if (isDdFrame(callsites[0])) return chain(error, callsites)

  let filtered
  let runStart = -1

  for (let i = 0; i < callsites.length; i++) {
    const callsite = callsites[i]
    if (isDdFrame(callsite)) {
      if (runStart === -1) runStart = i
      continue
    }
    if (runStart !== -1) {
      const leftIsUser = isUserFrame(callsites[runStart - 1])
      const rightIsUser = isUserFrame(callsite)
      if (leftIsUser && rightIsUser) {
        if (filtered !== undefined) {
          for (let runIndex = runStart; runIndex < i; runIndex++) filtered.push(callsites[runIndex])
        }
      } else if (filtered === undefined) {
        filtered = callsites.slice(0, runStart)
      }
      runStart = -1
    }
    if (filtered !== undefined) filtered.push(callsite)
  }
  if (runStart !== -1 && filtered === undefined) {
    filtered = callsites.slice(0, runStart)
  }

  return filtered === undefined ? chain(error, callsites) : chain(error, filtered)
}

/**
 * Idempotent. No-op unless `DD_TRACE_FILTER_OWN_FRAMES_EXPERIMENTAL=true`.
 *
 * @param {NodeJS.ProcessEnv} [env] Override for tests; defaults to `process.env`.
 */
function install (env) {
  if (installed) return
  // eslint-disable-next-line eslint-rules/eslint-process-env
  const source = env ?? process.env
  if (!isTrue(source.DD_TRACE_FILTER_OWN_FRAMES_EXPERIMENTAL)) return

  priorPrepareStackTrace = Error.prepareStackTrace
  Error.prepareStackTrace = ddTraceStackFilter
  module.exports.captureUnfilteredStack = activeCaptureUnfilteredStack
  installed = true
}

/**
 * Capture a stack on `target` and mark the carrier for bypass. Only ever
 * runs after `install()`; the inactive path forwards directly to
 * `Error.captureStackTrace` to keep `log.error` callers off a JS wrapper.
 *
 * @param {object} target
 * @param {Function} [constructorOpt]
 */
function activeCaptureUnfilteredStack (target, constructorOpt) {
  bypassSet.add(target)
  Error.captureStackTrace(target, constructorOpt)
}

/**
 * Return the unfiltered stack for an error. For a foreign error read after
 * install, opens a one-shot bypass window so V8 materialises the unfiltered
 * string on first read; if some other code read `.stack` first the cached
 * filtered string wins.
 *
 * @param {Error} error
 */
function formatUnfiltered (error) {
  if (!installed || bypassSet.has(error)) return error.stack
  bypassSet.add(error)
  try {
    return error.stack
  } finally {
    bypassSet.delete(error)
  }
}

module.exports = {
  install,
  // `install()` swaps this slot in. Default is `Error.captureStackTrace`
  // itself so `log.error` stays off a JS wrapper frame on the not-installed
  // path; callers must reach it through the module object, not destructure.
  captureUnfilteredStack: Error.captureStackTrace,
  formatUnfiltered,
  isDdFrame,
}
