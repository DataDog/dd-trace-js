'use strict'

const { addHook } = require('./helpers/instrument')
const { wrapThen } = require('./helpers/promise')
const shimmer = require('../../datadog-shimmer')

addHook({
  name: 'promise',
  file: 'lib/core.js',
  versions: ['>=7']
}, Promise => {
  shimmer.wrap(Promise.prototype, 'then', wrapThen)
  return Promise
})
