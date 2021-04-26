'use strict'
const suiteTest = require('../../dd-trace/test/plugins/suite')

describe('Plugin', () => {
  describe('restify test suite', () => {
    suiteTest('restify', 'restify/node-restify', 'latest')
  })
})
