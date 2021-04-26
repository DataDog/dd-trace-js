'use strict'
const suiteTest = require('../../dd-trace/test/plugins/suite')

describe('Plugin', () => {
  describe('bunyan test suite', () => {
    suiteTest('bunyan', 'trentm/node-bunyan', 'latest')
  })
})
