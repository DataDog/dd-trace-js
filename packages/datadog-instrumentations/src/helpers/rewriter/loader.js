'use strict'

const Module = require('module')
const shimmer = require('../../../../datadog-shimmer')
const { report } = require('./activation')
const { rewrite } = require('./')

shimmer.wrap(Module.prototype, '_compile', compile => function (content, filename, format) {
  return compile.call(this, rewrite(content, filename, format, report), filename, format)
})
