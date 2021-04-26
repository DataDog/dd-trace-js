'use strict'
const suiteTest = require('../../dd-trace/test/plugins/suite')

describe('Plugin', () => {
  describe('pino test suite', () => {
    suiteTest('pino', 'pinojs/pino', 'latest')
  })
})
