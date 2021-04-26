'use strict'
const suiteTest = require('../../dd-trace/test/plugins/suite')

describe('Plugin', () => {
  describe('connect test suite', () => {
    suiteTest('connect', 'senchalabs/connect', 'latest')
  })
})
