'use strict'

const Module = require('module')
const shimmer = require('../../../../datadog-shimmer')
const { rewrite } = require('./')

shimmer.wrap(Module.prototype, '_compile', compile => function (content, filename, format) {
  return compile.call(this, rewrite(content, filename, format), filename, format)
})
