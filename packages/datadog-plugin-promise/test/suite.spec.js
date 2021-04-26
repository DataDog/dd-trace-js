'use strict'
const suiteTest = require('../../dd-trace/test/plugins/suite')

describe('Plugin', () => {
  describe('promise test suite', () => {
    suiteTest('promise', 'then/promise', 'latest')
  })
})
