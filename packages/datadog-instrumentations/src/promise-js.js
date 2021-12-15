'use strict'

const { addHook } = require('./helpers/instrument')
const { wrapThen } = require('./helpers/promise')
const shimmer = require('../../datadog-shimmer')

addHook({
  name: 'promise-js',
  versions: ['>=0.0.3']
}, Promise => {
  if (Promise !== global.Promise) {
    shimmer.wrap(Promise.prototype, 'then', wrapThen)
  }
  return Promise
})
