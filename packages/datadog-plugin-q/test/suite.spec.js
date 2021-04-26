'use strict'
const suiteTest = require('../../dd-trace/test/plugins/suite')

describe('Plugin', () => {
  describe('winston test suite', () => {
    suiteTest('winston', 'winstonjs/winston', 'latest')
  })
})
