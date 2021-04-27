'use strict'
const suiteTest = require('../../dd-trace/test/plugins/suite')

describe('Plugin', () => {
  describe('pino test suite', () => {
    suiteTest({
      modName: 'pino',
      repoUrl: 'pinojs/pino',
      commitish: 'latest',
      testCmd: 'tap test/*test.js test/*/*test.js'
    })
  })
})
