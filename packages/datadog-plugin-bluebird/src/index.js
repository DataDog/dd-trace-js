'use strict'

const tx = require('../../dd-trace/src/plugins/util/promise')

function createGetNewLibraryCopyWrap (tracer, config, shim) {
  return function wrapGetNewLibraryCopy (getNewLibraryCopy) {
    return function getNewLibraryCopyWithTrace () {
      const result = getNewLibraryCopy.apply(this, arguments)
      shim.wrap(result.prototype, '_then', tx.createWrapThen(tracer, config))
      return result
    }
  }
}

module.exports = [
  {
    name: 'bluebird',
    versions: ['>=2.0.2'], // 2.0.0 and 2.0.1 were removed from npm
    patch (Promise, tracer, config) {
      this.wrap(Promise.prototype, '_then', tx.createWrapThen(tracer, config))
      
      if(Promise.getNewLibraryCopy) {
        this.wrap(Promise, 'getNewLibraryCopy', createGetNewLibraryCopyWrap(tracer, config, this))  
      }
    },
    unpatch (Promise) {
      this.unwrap(Promise.prototype, '_then')
      
      if(Prommise.getNewLibraryCopy) {
        this.unwrap(Promise, 'getNewLibraryCopy')
      }
    }
  }
]
