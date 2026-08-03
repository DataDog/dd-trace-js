'use strict'

const Module = require('module')
const shimmer = require('../../../../datadog-shimmer')
const { rewrite } = require('./')

const syncSourceRewritingSymbol = Symbol.for('dd-trace.loader.sync-source-rewriting')

shimmer.wrap(Module.prototype, '_compile', compile => function (content, filename, format) {
  if (globalThis[syncSourceRewritingSymbol]) {
    return compile.call(this, content, filename, format)
  }

  return compile.call(this, rewrite(content, filename, format), filename, format)
})
