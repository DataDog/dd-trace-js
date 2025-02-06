'use strict'

const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

const serviceName = {
  serviceName: 'test-couchbase'
}

const v1schema = {
  opName: 'couchbase.query',
  serviceName: 'test'
}

const rawExpectedSchema = {
  query: {
    v0: {
      ...serviceName,
      opName: 'couchbase.query'
    },
    v1: v1schema
  },
  upsert: {
    v0: {
      ...serviceName,
      opName: 'couchbase.upsert'
    },
    v1: v1schema
  }
}

module.exports = {
  rawExpectedSchema,
  expectedSchema: resolveNaming(rawExpectedSchema)
}
