'use strict'
const suiteTest = require('../../dd-trace/test/plugins/suite')

describe('Plugin', () => {
  describe('cassandra-driver test suite', () => {
    suiteTest('cassandra-driver', 'datastax/nodejs-driver', 'latest')
  })
})
