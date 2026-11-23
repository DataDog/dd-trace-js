'use strict'

// Preloaded before the tracer: counts the rewriter's transforms of each fixture dependency, so a rewrite whose output
// is thrown away shows up even though the module that runs is instrumented once.
const rewriter = require('../../../../../src/helpers/rewriter')

const { rewrite } = rewriter
const fixtureModules = '/module-hooks/node_modules/'
/** @type {Record<string, number>} */
const rewriteCounts = {}

rewriter.rewrite = function (content, filename, ...args) {
  const index = filename.indexOf(fixtureModules)
  if (index !== -1) {
    const name = filename.slice(index + fixtureModules.length)
    rewriteCounts[name] = (rewriteCounts[name] ?? 0) + 1
  }
  return rewrite.call(this, content, filename, ...args)
}

globalThis.rewriteCounts = rewriteCounts
