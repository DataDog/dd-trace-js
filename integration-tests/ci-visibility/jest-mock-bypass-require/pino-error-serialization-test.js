'use strict'

const assert = require('node:assert/strict')

const { stdSerializers } = require('pino')

describe('Pino error serialization', () => {
  it('serializes errors created in the Jest realm', () => {
    const serializedError = stdSerializers.err(new Error('test error'))

    assert.strictEqual(serializedError.type, 'Error')
  })
})
