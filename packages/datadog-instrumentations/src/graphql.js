'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

// Orchestrion rewriter handles wrapping of:
// - graphql: execute, parse, validate (CJS + ESM)
// - @graphql-tools/executor: execute, normalizedExecutor (CJS + ESM)
// See helpers/rewriter/instrumentations/graphql.js for the full config.
for (const hook of getHooks('graphql')) {
  addHook(hook, exports => exports)
}

for (const hook of getHooks('@graphql-tools/executor')) {
  addHook(hook, exports => exports)
}

// Multiple graphql-jit rewrites share each build file; register one hook per file.
const graphqlJitFiles = new Set()
for (const hook of getHooks('graphql-jit')) {
  if (graphqlJitFiles.has(hook.file)) continue
  graphqlJitFiles.add(hook.file)
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
