'use strict'
const suiteTest = require('../../dd-trace/test/plugins/suite')

describe('Plugin', () => {
  describe.skip('ioredis test suite', () => {
    suiteTest('ioredis', 'luin/ioredis', 'latest')
  })
})
