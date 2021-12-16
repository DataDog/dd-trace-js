'use strict'

const { addHook } = require('./helpers/instrument')
const { wrapThen } = require('./helpers/promise')
const shimmer = require('../../datadog-shimmer')

const DD_LIB_COPIES = '_datadog_library_copies'

function createGetNewLibraryCopyWrap (originalLib) {
  return function wrapGetNewLibraryCopy (getNewLibraryCopy) {
    return function getNewLibraryCopyWithTrace () {
      const libraryCopy = getNewLibraryCopy.apply(this, arguments)
      shimmer.wrap(libraryCopy.prototype, '_then', wrapThen)
      shimmer.wrap(libraryCopy, 'getNewLibraryCopy', createGetNewLibraryCopyWrap(originalLib))
      addToLibraryCopies(originalLib, libraryCopy)
      return libraryCopy
    }
  }
}

function addToLibraryCopies (originalLib, libraryCopy) {
  let libraryCopies = originalLib[DD_LIB_COPIES]

  if (!libraryCopies) {
    libraryCopies = new Set()

    Object.defineProperty(originalLib, DD_LIB_COPIES, {
      writable: true,
      configurable: true,
      value: libraryCopies
    })
  }
  libraryCopies.add(libraryCopy)
}

addHook({ name: 'bluebird', versions: ['>=2.0.2'] }, Promise => {
  shimmer.wrap(Promise.prototype, '_then', wrapThen)
  return Promise
})

addHook({ name: 'bluebird', versions: ['^2.11.0', '^3.4.1'] }, Promise => {
  shimmer.wrap(Promise, 'getNewLibraryCopy', createGetNewLibraryCopyWrap(Promise))
  return Promise
})
