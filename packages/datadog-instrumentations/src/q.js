'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')
const { wrapThen } = require('./helpers/promise')

addHook({
  name: 'q',
  versions: ['1']
}, Q => {
  shimmer.wrap(Q.makePromise.prototype, 'then', wrapThen)
  return Q
})

addHook({
  name: 'q',
  versions: ['>=2']
}, Q => {
  shimmer.wrap(Q.Promise.prototype, 'then', wrapThen)
  return Q
})
