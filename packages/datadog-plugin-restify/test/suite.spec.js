'use strict'
const suiteTest = require('../../dd-trace/test/plugins/suite')

describe('Plugin', () => {
  describe.skip('restify test suite', () => {
    suiteTest('restify', 'restify/node-restify', 'latest')
  })
})
