'use strict'
const suiteTest = require('../../dd-trace/test/plugins/suite')

describe('Plugin', () => {
  describe.skip('cassandra-driver test suite', () => {
    suiteTest('cassandra-driver', 'datastax/nodejs-driver', 'latest')
  })
})
