'use strict'

const { addHook } = require('./helpers/instrument')
const { wrapThen } = require('./helpers/promise')
const shimmer = require('../../datadog-shimmer')

addHook({
  name: 'q',
  versions: ['>=1']
}, Q => {
  shimmer.wrap(Q.makePromise.prototype, 'then', wrapThen)
  return Q
})
