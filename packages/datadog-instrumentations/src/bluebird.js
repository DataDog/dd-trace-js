'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')
const { wrapThen } = require('./helpers/promise')

function createGetNewLibraryCopyWrap (originalLib) {
  return function wrapGetNewLibraryCopy (getNewLibraryCopy) {
    return function getNewLibraryCopyWithTrace (...args) {
      const libraryCopy = getNewLibraryCopy.apply(this, args)
      shimmer.wrap(libraryCopy.prototype, '_then', wrapThen)
      shimmer.wrap(libraryCopy, 'getNewLibraryCopy', createGetNewLibraryCopyWrap(originalLib))
      return libraryCopy
    }
  }
}

addHook({ name: 'bluebird', versions: ['>=2.0.2'] }, LibraryPromise => {
  shimmer.wrap(LibraryPromise.prototype, '_then', wrapThen)
  return LibraryPromise
})

addHook({ name: 'bluebird', versions: ['^2.11.0', '^3.4.1'] }, LibraryPromise => {
  shimmer.wrap(LibraryPromise, 'getNewLibraryCopy', createGetNewLibraryCopyWrap(LibraryPromise))
  return LibraryPromise
})
