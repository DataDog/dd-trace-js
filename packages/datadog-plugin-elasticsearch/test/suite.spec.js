'use strict'
const suiteTest = require('../../dd-trace/test/plugins/suite')

describe('Plugin', () => {
  describe.skip('elasticsearch test suite', () => {
    suiteTest('elasticsearch', 'elastic/elasticsearch-js-legacy', 'latest')
  })
})
