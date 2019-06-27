'use strict'

const tx = require('../../dd-trace/src/plugins/util/promise')

function createPatch (file) {
  return {
    name: 'knex',
    versions: ['>=0.8.0'],
    file,
    patch (Builder, tracer, config) {
      this.wrap(Builder.prototype, 'then', tx.createWrapThen(tracer, config))
    },
    unpatch (Builder) {
      this.unwrap(Builder.prototype, 'then')
    }
  }
}

module.exports = [
  createPatch('lib/query/builder.js'),
  createPatch('lib/raw.js'),
  createPatch('lib/schema/builder.js')
]
