'use strict'

const Module = require('module')
const shimmer = require('../../../../datadog-shimmer')
const { rewrite } = require('./')

require('./register-hook.js')

const rewrittenForCompileSymbol = Symbol.for('dd-trace.loader.rewritten-for-compile')

shimmer.wrap(Module.prototype, '_compile', compile => function (content, filename, format) {
  const rewritten = globalThis[rewrittenForCompileSymbol]?.delete(filename)
    ? content
    : rewrite(content, filename, format)

  return compile.call(this, rewritten, filename, format)
})
