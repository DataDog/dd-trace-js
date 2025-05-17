'use strict'

require('../../../setup/mocha')

const assert = require('node:assert')

require('./stub-session')
const { getLocalStateForCallFrame } = require('../../../../src/debugger/devtools_client/snapshot')

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
