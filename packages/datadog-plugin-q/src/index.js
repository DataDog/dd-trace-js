'use strict'

const { wrapThen } = require('../../datadog-instrumentations/src/helpers/promise')

module.exports = [
  {
    name: 'q',
    versions: ['>=1'],
    patch (Q, tracer, config) {
      this.wrap(Q.makePromise.prototype, 'then', wrapThen)
    },
    unpatch (Q) {
      this.unwrap(Q.makePromise.prototype, 'then')
    }
  }
]
