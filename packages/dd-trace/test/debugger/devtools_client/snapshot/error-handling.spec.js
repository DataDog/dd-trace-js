'use strict'

require('../../../setup/mocha')

const assert = require('node:assert')

const { getLocalStateForCallFrame } = require('./utils')

describe('debugger -> devtools client -> snapshot.getLocalStateForCallFrame', function () {
  describe('error handling', function () {
    it('should generate a notCapturedReason if an error is thrown during inital collection', async function () {
      const invalidCallFrameThatTriggersAnException = {}
      const processLocalState = await getLocalStateForCallFrame(invalidCallFrameThatTriggersAnException)
      const result = processLocalState()
      assert.ok(result instanceof Error)
      assert.strictEqual(result.message, 'Error getting local state')
    })
  })
})
