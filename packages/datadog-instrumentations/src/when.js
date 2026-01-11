'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')
const { wrapThen } = require('./helpers/promise')

addHook({
  name: 'when',
  file: 'lib/Promise.js',
  versions: ['>=3']
}, Promise => {
  shimmer.wrap(Promise.prototype, 'then', wrapThen)
  return Promise
})
