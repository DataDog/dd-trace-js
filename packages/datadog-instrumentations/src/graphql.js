'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

const ddGlobal = globalThis[Symbol.for('dd-trace')]

// Orchestrion rewriter handles wrapping of:
// - graphql: execute, executeField, parse, validate (CJS + ESM)
// - @graphql-tools/executor: execute, normalizedExecutor (index + CJS sub-path)
// See helpers/rewriter/instrumentations/graphql.js for the full config.
//
// The rewriter instruments executeField() in execution/execute.js, which is the
// single execution point ALL resolvers flow through at runtime. This replaces the
// dynamic wrapFields()/wrapResolve() pattern that individually wrapped each field
// resolver on schema types at execute time.

for (const hook of getHooks('graphql')) {
  addHook(hook, exports => exports)
}

for (const hook of getHooks('@graphql-tools/executor')) {
  addHook(hook, exports => exports)
}

// Module-load hooks: store module references on ddGlobal for cross-plugin access.
// These are NOT function wraps — they capture module exports at load time for use
// by @apollo/gateway and other plugins that may load after graphql.

addHook({ name: 'graphql', file: 'language/printer.js', versions: ['>=0.10'] }, printer => {
  ddGlobal.graphql_printer = printer
  return printer
})

addHook({ name: 'graphql', file: 'language/visitor.js', versions: ['>=0.10'] }, visitor => {
  ddGlobal.graphql_visitor = visitor
  return visitor
})

addHook({ name: 'graphql', file: 'utilities/index.js', versions: ['>=0.10'] }, utilities => {
  ddGlobal.graphql_utilities = utilities
  return utilities
})
