'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')
const { wrapThen } = require('./helpers/promise')

addHook({
  name: 'promise-js',
  versions: ['>=0.0.3'],
}, LibraryPromise => {
  if (LibraryPromise !== global.Promise) {
    shimmer.wrap(LibraryPromise.prototype, 'then', wrapThen)
  }
  return LibraryPromise
})
