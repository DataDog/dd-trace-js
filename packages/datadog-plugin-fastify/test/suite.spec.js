'use strict'
const suiteTest = require('../../dd-trace/test/plugins/suite')

describe('Plugin', () => {
  describe('fastify test suite', () => {
    suiteTest('fastify', 'fastify/fastify', 'latest')
  })
})
