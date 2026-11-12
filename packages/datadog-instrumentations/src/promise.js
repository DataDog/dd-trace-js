'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')
const { wrapThen } = require('./helpers/promise')

addHook({
  name: 'promise',
  file: 'lib/core.js',
  versions: ['>=7'],
}, LibraryPromise => {
  shimmer.wrap(LibraryPromise.prototype, 'then', wrapThen)
  return LibraryPromise
})
