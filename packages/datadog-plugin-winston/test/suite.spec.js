'use strict'
const suiteTest = require('../../dd-trace/test/plugins/suite')

describe('Plugin', () => {
  describe('q test suite', () => {
    suiteTest('q', 'kriskowal/q', 'latest')
  })
})
