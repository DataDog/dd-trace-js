'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

// Orchestrion rewriter handles wrapping of:
// - graphql: execute, parse, validate (CJS + ESM)
// - @graphql-tools/executor: execute, normalizedExecutor (CJS + ESM)
// See helpers/rewriter/instrumentations/graphql.js for the full config.
//
// The plugin (packages/datadog-plugin-graphql/src/execute.js) handles the
// `apm:graphql:execute:start` AppSec/WAF contract from inside its bindStart:
// publishing the channel synchronously runs subscribers, and an
// `abortController.abort()` from a subscriber is observed by replacing
// `ctx.arguments[0]` with an object whose getters throw AbortError. The
// orchestrion-emitted wrapper's `catch { ...; throw err }` block propagates
// that throw to the caller of graphql.execute. No outer wrap needed.

for (const hook of getHooks('graphql')) {
  addHook(hook, exports => exports)
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
