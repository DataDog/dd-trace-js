'use strict'

const fs = require('fs')
const Module = require('module')
const shimmer = require('../../../../datadog-shimmer')
const { isReadRewriteEnabled } = require('./require-esm')
const { getRewriteTarget } = require('./targets')
const { rewrite } = require('./')

shimmer.wrap(Module.prototype, '_compile', compile => function (content, filename, format) {
  return compile.call(this, rewrite(content, filename, format), filename, format)
})

// require(esm) hands only the entry module to Module.prototype._compile. Node's ESM loader reads
// every module the entry imports with fs.readFileSync(fileUrl), on this thread whenever no loader
// hook handles the load here (no hooks, or Node 20 asynchronous hooks, which skip require(esm)).
// Rewriting that read reaches the graph without registering hooks or loading a second CommonJS copy.
// Node 24+ looks fs.readFileSync up on each read. Node 20 and 22 bind it once, when their ESM loader
// first loads, so there this covers graphs required after dd-trace loads, as init already requires.
// eslint-disable-next-line n/no-unsupported-features/node-builtins -- Feature detection for require(esm).
if (process.features.require_module) {
  shimmer.wrap(fs, 'readFileSync', readFileSync => function (path) {
    const content = readFileSync.apply(this, arguments)

    if (
      arguments.length !== 1 ||
      !(path instanceof URL) ||
      path.protocol !== 'file:' ||
      !path.pathname.endsWith('.mjs') ||
      !isReadRewriteEnabled()
    ) {
      return content
    }

    const target = getRewriteTarget(path.href)
    if (!target) return content

    const code = rewrite(content, path.href, 'module', target)

    return code === content ? content : Buffer.from(code)
  })
}
