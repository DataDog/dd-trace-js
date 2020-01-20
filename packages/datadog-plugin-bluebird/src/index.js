'use strict'

const tx = require('../../dd-trace/src/plugins/util/promise')

const DD_LIB_COPIES = '_datadog_library_copies'

function createGetNewLibraryCopyWrap (tracer, config, originalLib, shim) {
  return function wrapGetNewLibraryCopy (getNewLibraryCopy) {
    return function getNewLibraryCopyWithTrace () {
      const libraryCopy = getNewLibraryCopy.apply(this, arguments)
      shim.wrap(libraryCopy.prototype, '_then', tx.createWrapThen(tracer, config))
      shim.wrap(libraryCopy, 'getNewLibraryCopy', createGetNewLibraryCopyWrap(tracer, config, originalLib, shim))
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

function unwrapLibraryCopies (originalLib, shim) {
  const libraryCopies = originalLib[DD_LIB_COPIES]

  if (libraryCopies) {
    libraryCopies.forEach(libraryCopy => {
      shim.unwrap(libraryCopy.prototype, '_then')
      shim.unwrap(libraryCopy, 'getNewLibraryCopy')
    })
    libraryCopies.clear()
    delete originalLib[DD_LIB_COPIES]
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
      unwrapLibraryCopies(Promise, this)
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
