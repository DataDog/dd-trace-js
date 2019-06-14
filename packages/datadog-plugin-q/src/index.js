'use strict'

const tx = require('../../dd-trace/src/plugins/util/promise')

module.exports = [
  {
    name: 'q',
    versions: ['>=1'],
    patch (Q, tracer, config) {
      this.wrap(Q.makePromise.prototype, 'then', tx.createWrapThen(tracer, config))
    },
    unpatch (Q) {
      this.unwrap(Q.makePromise.prototype, 'then')
    }
  }
]
