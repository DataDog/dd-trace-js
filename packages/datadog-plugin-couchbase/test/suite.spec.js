'use strict'
const suiteTest = require('../../dd-trace/test/plugins/suite')

describe('Plugin', () => {
  describe.skip('couchbase test suite', () => {
    suiteTest('couchbase', 'couchbase/couchnode', 'v3.1.3')
  })
})
