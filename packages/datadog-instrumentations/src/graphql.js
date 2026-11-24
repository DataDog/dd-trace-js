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
  const hooks = new Map()
  for (const hook of getHooks(name).values()) {
    const existing = hooks.get(hook.file)
    if (existing) {
      existing.versions.push(...hook.versions)
    } else {
      hooks.set(hook.file, hook)
    }
  }
  for (const hook of hooks.values()) {
    addHook(hook, exports => exports)
  }
}

addRewriterHooks('graphql')
addRewriterHooks('@graphql-tools/executor')
addRewriterHooks('graphql-jit')

// Module-load hooks: capture references on ddGlobal for cross-plugin access
// (read lazily inside each callback so agent.load() between mocha suites can
// rebind globalThis[dd-trace] without us stashing a stale reference).

// Capture ESM namespace exports through module hooks: __module_export__ only matches CommonJS exports.
for (const extension of ['js', 'mjs']) {
  addHook({ name: 'graphql', file: `language/printer.${extension}`, versions: ['>=0.10'] }, printer => {
    const ddGlobal = globalThis[Symbol.for('dd-trace')]
    if (ddGlobal) ddGlobal.graphql_printer = printer
    return printer
  })

  addHook({ name: 'graphql', file: `language/visitor.${extension}`, versions: ['>=0.10'] }, visitor => {
    const ddGlobal = globalThis[Symbol.for('dd-trace')]
    if (ddGlobal) ddGlobal.graphql_visitor = visitor
    return visitor
  })

  addHook({ name: 'graphql', file: `utilities/index.${extension}`, versions: ['>=0.10'] }, utilities => {
    const ddGlobal = globalThis[Symbol.for('dd-trace')]
    if (ddGlobal) ddGlobal.graphql_utilities = utilities
    return utilities
  })
}
