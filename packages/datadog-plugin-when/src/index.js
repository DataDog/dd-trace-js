'use strict'

const tx = require('../../dd-trace/src/plugins/util/promise')

module.exports = [
  {
    name: 'when',
    file: 'lib/Promise.js',
    versions: ['>=3'],
    patch (Promise, tracer, config) {
      this.wrap(Promise.prototype, 'then', tx.createWrapThen(tracer, config))
    },
    unpatch (Promise) {
      this.unwrap(Promise.prototype, 'then')
    }
  }
]
