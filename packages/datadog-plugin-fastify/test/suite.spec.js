'use strict'
const suiteTest = require('../../dd-trace/test/plugins/suite')

describe('Plugin', () => {
  describe('fastify test suite', () => {
    suiteTest({
      modName: 'fastify',
      repoUrl: 'fastify/fastify',
      commitish: 'latest',
      testCmd: 'tap -J test/*.test.js test/*/*.test.js'
    })
  })
})
