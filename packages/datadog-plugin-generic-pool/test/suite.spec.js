'use strict'
const suiteTest = require('../../dd-trace/test/plugins/suite')

describe('Plugin', () => {
  describe('generic-pool test suite', () => {
    suiteTest('generic-pool', 'coopernurse/node-pool', 'v2.5.0')
  })
})
