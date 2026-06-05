'use strict'

const dc = require('dc-polyfill')
const { addHook, getHooks } = require('./helpers/instrument')

// Orchestrion rewriter handles wrapping of:
// - graphql: execute, executeField, parse, validate (CJS + ESM)
// - @graphql-tools/executor: execute, normalizedExecutor (index + CJS sub-path)
// See helpers/rewriter/instrumentations/graphql.js for the full config.
//
// The rewriter instruments executeField() in execution/execute.js, which is the
// single execution point ALL resolvers flow through at runtime. This replaces the
// dynamic wrapFields()/wrapResolve() pattern that individually wrapped each field
// resolver on schema types at execute time.

// `apm:graphql:execute:start` is master's pre-execute hook used by AppSec/WAF to
// observe the request and abort it synchronously by calling
// `ctx.abortController.abort()`. Orchestrion's emitted wrapper catches throws
// from channel subscribers and bindStore transforms (dc-polyfill's
// wrapStoreRun re-raises them via process.nextTick and continues), so the abort
// gate cannot live inside the plugin's bindStart. We wrap `execute` itself at
// the module-load hook, sitting *outside* orchestrion's try-block, where a
// synchronous throw propagates cleanly to the caller of graphql.execute().
//
// On abort, we publish an internal `datadog:graphql:execute:abort` channel so
// the plugin can produce a clean execute span for the trace without delegating
// to the underlying execute (which would invoke resolvers).
const startExecuteCh = dc.channel('apm:graphql:execute:start')
const abortExecuteCh = dc.channel('datadog:graphql:execute:abort')

class AbortError extends Error {
  constructor (message) {
    super(message)
    this.name = 'AbortError'
  }
}

function wrapExecute (originalExecute) {
  return function wrappedExecute () {
    if (!startExecuteCh.hasSubscribers) {
      return originalExecute.apply(this, arguments)
    }

    // Object-form ({ schema, document, ... }) and positional form
    // (schema, document, rootValue, contextValue, ...) are both supported by
    // graphql.execute. AppSec subscribers only care about the document/args
    // shape; we only forward the object form here (positional is rare and
    // master's WAF handler keys off the same).
    const opts = (typeof arguments[0] === 'object' && arguments[0] !== null && !Array.isArray(arguments[0]))
      ? arguments[0]
      : undefined

    const startCtx = {
      abortController: new AbortController(),
      args: opts,
    }
    startExecuteCh.publish(startCtx)

    if (startCtx.abortController.signal.aborted) {
      // Hand off to the plugin (subscribed below) to create + finish a clean
      // execute span. The plugin's bindStart never runs on this path because
      // we never delegate to originalExecute — so the abort branch needs its
      // own span-lifecycle entry point.
      abortExecuteCh.publish({ args: opts })
      throw new AbortError('Aborted')
    }

    return originalExecute.apply(this, arguments)
  }
}

function patchExecuteExport (exports) {
  if (typeof exports?.execute !== 'function') return exports
  const orig = exports.execute
  // Idempotency guard: don't double-wrap if the load hook fires twice.
  if (orig.__dd_wrapped) return exports
  const wrapped = wrapExecute(orig)
  wrapped.__dd_wrapped = true
  try {
    exports.execute = wrapped
  } catch {
    // Some builds expose execute as a getter-only property; force the override.
    Object.defineProperty(exports, 'execute', { value: wrapped, configurable: true, writable: true })
  }
  return exports
}

for (const hook of getHooks('graphql')) {
  if (hook.file === 'execution/execute.js' || hook.file === 'execution/execute.mjs') {
    addHook(hook, patchExecuteExport)
  } else {
    addHook(hook, exports => exports)
  }
}

for (const hook of getHooks('@graphql-tools/executor')) {
  addHook(hook, exports => exports)
}

// Module-load hooks: store module references on ddGlobal for cross-plugin access.
// These are NOT function wraps — they capture module exports at load time for use
// by @apollo/gateway and other plugins that may load after graphql.
// NOTE: ddGlobal is read lazily inside each callback (not at module load time) to
// avoid capturing a stale reference when agent.load() recreates the ddGlobal object.

addHook({ name: 'graphql', file: 'language/printer.js', versions: ['>=0.10'] }, printer => {
  const ddGlobal = globalThis[Symbol.for('dd-trace')]
  if (ddGlobal) ddGlobal.graphql_printer = printer
  return printer
})

addHook({ name: 'graphql', file: 'language/visitor.js', versions: ['>=0.10'] }, visitor => {
  const ddGlobal = globalThis[Symbol.for('dd-trace')]
  if (ddGlobal) ddGlobal.graphql_visitor = visitor
  return visitor
})

addHook({ name: 'graphql', file: 'utilities/index.js', versions: ['>=0.10'] }, utilities => {
  const ddGlobal = globalThis[Symbol.for('dd-trace')]
  if (ddGlobal) ddGlobal.graphql_utilities = utilities
  return utilities
})
