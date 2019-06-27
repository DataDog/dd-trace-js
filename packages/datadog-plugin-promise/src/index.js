'use strict'

const tx = require('../../dd-trace/src/plugins/util/promise')

module.exports = [
  {
    name: 'promise',
    file: 'lib/core.js',
    versions: ['>=7'],
    patch (Promise, tracer, config) {
      this.wrap(Promise.prototype, 'then', tx.createWrapThen(tracer, config))
    },
    unpatch (Promise) {
      this.unwrap(Promise.prototype, 'then')
    }
  }
]
