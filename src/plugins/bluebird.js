'use strict'

const tx = require('./util/promise')

module.exports = [
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
