'use strict'

require('../../../setup/mocha')

const assert = require('node:assert')

const { getLocalStateForCallFrame } = require('./utils')

describe('debugger -> devtools client -> snapshot.getLocalStateForCallFrame', function () {
  describe('error handling', function () {
    it('should generate a notCapturedReason if getRuntimeObject rejects', async function () {
      const mockCallFrame = {
        // `42` isn't a valid object id, so we should get an error
        scopeChain: [{ type: 'local', object: { objectId: '42' } }],
      }
      const { captureErrors, processLocalState } = await getLocalStateForCallFrame(mockCallFrame)

      assert.strictEqual(captureErrors.length, 1)

      for (const error of captureErrors) {
        assert.ok(error instanceof Error)
        assert.strictEqual(
          error.message,
          'Error getting local state for closure scope (type: local). ' +
          'Future snapshots for existing probes in this location will be skipped until the Node.js process is restarted'
        )

        const { cause } = error
        assert.ok(cause instanceof Error)
        assert.strictEqual(cause.message, 'Inspector error -32000: Invalid remote object id')
      }

      assert.deepStrictEqual(processLocalState(), {})
    })
  })
})
