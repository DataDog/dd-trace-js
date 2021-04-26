'use strict'
const suiteTest = require('../../dd-trace/test/plugins/suite')

describe('Plugin', () => {
  describe('ioredis test suite', () => {
    suiteTest('ioredis', 'luin/ioredis', 'latest')
  })
})
