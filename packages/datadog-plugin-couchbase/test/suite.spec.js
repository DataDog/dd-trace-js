'use strict'
const suiteTest = require('../../dd-trace/test/plugins/suite')

describe('Plugin', () => {
  describe('couchbase test suite', () => {
    suiteTest('couchbase', 'trentm/node-bunyan', 'latest')
  })
})
