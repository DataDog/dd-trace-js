'use strict'

const { ddBasePath } = require('../util')

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

// Errors in this set bypass the filter; used by `captureUnfilteredStack` so the
// dd-trace-internal log carrier always sees the full stack regardless of who
// else has installed an `Error.prepareStackTrace`.
const bypassSet = new WeakSet()

// Stash unfiltered stacks at capture time so subscribers can read them later
// without racing V8's lazy formatter cache.
const unfilteredStashes = new WeakMap()

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
          for (let j = runStart; j < i; j++) filtered.push(callsites[j])
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
 * Install the filter once. The feature is opt-in behind
 * `DD_TRACE_FILTER_OWN_FRAMES_EXPERIMENTAL=true` for the first release;
 * `DD_TRACE_FILTER_OWN_FRAMES=false` opts out, and
 * `DD_TRACE_INTERNAL_TEST_HARNESS` short-circuits installation so the dd-trace
 * test suite sees unfiltered stacks.
 *
 * @param {{
 *   DD_TRACE_FILTER_OWN_FRAMES?: boolean,
 *   DD_TRACE_FILTER_OWN_FRAMES_EXPERIMENTAL?: boolean,
 *   DD_TRACE_INTERNAL_TEST_HARNESS?: unknown
 * }} config
 */
function install (config) {
  if (installed) return
  if (config.DD_TRACE_INTERNAL_TEST_HARNESS) return
  if (config.DD_TRACE_FILTER_OWN_FRAMES === false) return
  if (config.DD_TRACE_FILTER_OWN_FRAMES_EXPERIMENTAL !== true) return

  priorPrepareStackTrace = Error.prepareStackTrace
  Error.prepareStackTrace = ddTraceStackFilter
  installed = true
}

/**
 * Capture a stack on `target` while the filter treats it as a bypass error.
 * The eager `target.stack` read materialises V8's lazy formatter against the
 * prior installer (or the default formatter) and the resulting string is
 * stashed for later `formatUnfiltered` lookups.
 *
 * @param {object} target
 * @param {Function} [constructorOpt]
 */
function captureUnfilteredStack (target, constructorOpt) {
  bypassSet.add(target)
  try {
    Error.captureStackTrace(target, constructorOpt)
    const unfiltered = target.stack
    unfilteredStashes.set(target, unfiltered)
    return unfiltered
  } finally {
    bypassSet.delete(target)
  }
}

/**
 * Return the unfiltered stack for an error.
 *
 * Fast path: the error was captured via `captureUnfilteredStack`, so the
 * stashed string is authoritative. Slow path with no filter installed: read
 * `error.stack` directly. Slow path with the filter installed and no stash:
 * best-effort read inside a bypass window; V8 may have cached a filtered
 * string already, in which case the cached value wins.
 *
 * @param {Error} error
 */
function formatUnfiltered (error) {
  const stashed = unfilteredStashes.get(error)
  if (stashed !== undefined) return stashed
  if (!installed) return error.stack
  bypassSet.add(error)
  try {
    return error.stack
  } finally {
    bypassSet.delete(error)
  }
}

module.exports = {
  install,
  captureUnfilteredStack,
  formatUnfiltered,
  isDdFrame,
}
