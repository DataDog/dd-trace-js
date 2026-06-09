'use strict'

const dc = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const { addHook, getHooks } = require('./helpers/instrument')

// Orchestrion rewriter handles wrapping of:
// - graphql: execute, executeField, parse, validate (CJS + ESM)
// - @graphql-tools/executor: execute, normalizedExecutor (index + CJS sub-path)
// See helpers/rewriter/instrumentations/graphql.js for the full config.
//
// In addition to the orchestrion lifecycle, `execute` itself gets a shimmer
// wrap below — `apm:graphql:execute:start` subscribers (AppSec/WAF) abort
// synchronously via `ctx.abortController.abort()` and need that throw to
// surface from the caller of graphql.execute(). Orchestrion's emitted wrapper
// catches throws from both channel subscribers and bindStore transforms
// (dc-polyfill's wrapStoreRun re-raises asynchronously and continues), so the
// abort gate must live outside that try-block.

const startExecuteCh = dc.channel('apm:graphql:execute:start')
const abortExecuteCh = dc.channel('datadog:graphql:execute:abort')

// Functions already wrapped (across module reloads or repeated load hooks).
const wrappedExecutes = new WeakSet()

class AbortError extends Error {
  constructor (message) {
    super(message)
    this.name = 'AbortError'
  }
}

function wrapExecute (originalExecute) {
  if (wrappedExecutes.has(originalExecute)) return originalExecute

  function wrappedExecute () {
    if (!startExecuteCh.hasSubscribers) {
      return originalExecute.apply(this, arguments)
    }

    const startCtx = {
      abortController: new AbortController(),
      args: arguments[0],
    }
    startExecuteCh.publish(startCtx)

    if (startCtx.abortController.signal.aborted) {
      // Orchestrion's lifecycle never runs because we don't delegate — the
      // plugin needs its own entry point to produce the execute span.
      abortExecuteCh.publish({ args: arguments[0] })
      throw new AbortError('Aborted')
    }

    return originalExecute.apply(this, arguments)
  }

  wrappedExecutes.add(wrappedExecute)
  return wrappedExecute
}

function patchExecuteExport (exports) {
  if (typeof exports?.execute === 'function') {
    shimmer.wrap(exports, 'execute', wrapExecute)
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

// Module-load hooks: capture references on ddGlobal for cross-plugin access
// (read lazily inside each callback so agent.load() between mocha suites can
// rebind globalThis[dd-trace] without us stashing a stale reference).

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
