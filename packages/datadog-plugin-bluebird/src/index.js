'use strict'

const tx = require('../../dd-trace/src/plugins/util/promise')

const DD_LIB_COPIES = '_datadog_library_copies'

function createGetNewLibraryCopyWrap (tracer, config, originalLib, shim) {
  return function wrapGetNewLibraryCopy (getNewLibraryCopy) {
    return function getNewLibraryCopyWithTrace () {
      const libraryCopy = getNewLibraryCopy.apply(this, arguments)
      shim.wrap(libraryCopy.prototype, '_then', tx.createWrapThen(tracer, config))
      addToLibraryCopies(originalLib.prototype, libraryCopy)
      return libraryCopy
    }
  }
}

function addToLibraryCopies (originalLibPrototype, libraryCopy) {
  let libraryCopies = originalLibPrototype[DD_LIB_COPIES]

  if (!libraryCopies) {
    libraryCopies = new Set()
    originalLibPrototype[DD_LIB_COPIES] = libraryCopies
  }

  libraryCopies.add(libraryCopy)
}

function unwrapLibraryCopies (originalLibPrototype, shim) {
  const libraryCopies = originalLibPrototype[DD_LIB_COPIES]

  if (libraryCopies) {
    libraryCopies.forEach(libraryCopy => shim.unwrap(libraryCopy.prototype, '_then'))
    libraryCopies.clear()
    delete originalLibPrototype[DD_LIB_COPIES]
  }
}

module.exports = [
  {
    name: 'bluebird',
    versions: ['^2.11.0', '^3.4.1'],
    patch (Promise, tracer, config) {
      this.wrap(Promise, 'getNewLibraryCopy', createGetNewLibraryCopyWrap(tracer, config, Promise, this))
    },
    unpatch (Promise) {
      this.unwrap(Promise, 'getNewLibraryCopy')
      unwrapLibraryCopies(Promise.prototype, this)
    }
  },
  {
    name: 'bluebird',
    versions: ['>=2.0.2'], // 2.0.0 and 2.0.1 were removed from npm
    patch (Promise, tracer, config) {
      this.wrap(Promise.prototype, '_then', tx.createWrapThen(tracer, config))
    },
    unpatch (Promise) {
      this.unwrap(Promise.prototype, '_then')
    }
  }
]
