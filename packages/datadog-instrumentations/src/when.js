'use strict'

const { addHook } = require('./helpers/instrument')
const { wrapThen } = require('./helpers/promise')
const shimmer = require('../../datadog-shimmer')

addHook({
  name: 'when',
  file: 'lib/Promise.js',
  versions: ['>=3']
}, Promise => {
  shimmer.wrap(Promise.prototype, 'then', wrapThen)
  return Promise
})
