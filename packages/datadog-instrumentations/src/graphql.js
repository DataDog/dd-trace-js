'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

// Orchestrion rewriter handles wrapping of:
// - graphql: execute, locatedError, parse, validate (CJS + ESM)
// - @graphql-tools/executor: execute, handleFieldError, normalizedExecutor (CJS + ESM)
// See helpers/rewriter/instrumentations/graphql.js for the full config.

/**
 * @param {string} name
 */
function addRewriterHooks (name) {
  const files = new Set()
  for (const hook of getHooks(name)) {
    if (files.has(hook.file)) continue
    files.add(hook.file)
    addHook(hook, exports => exports)
  }
}

addRewriterHooks('graphql')
addRewriterHooks('@graphql-tools/executor')
addRewriterHooks('graphql-jit')

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
