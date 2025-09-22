'use strict'

const { expect } = require('chai')
const { describe, it } = require('mocha')

require('../../setup/mocha')

const JSONBuffer = require('../../../src/debugger/devtools-client/json-buffer')

const MAX_SAFE_SIGNED_INTEGER = 2 ** 31 - 1

describe('JSONBuffer', () => {
  it('should call onFlush with the expected payload when the timeout is reached', function (done) {
    const onFlush = (json) => {
      const diff = Date.now() - start
      expect(json).to.equal('[{"message":1},{"message":2},{"message":3}]')
      expect(diff).to.be.within(95, 110)
      done()
    }

    const jsonBuffer = new JSONBuffer({ size: Infinity, timeout: 100, onFlush })

    const start = Date.now()
    jsonBuffer.write(JSON.stringify({ message: 1 }))
    jsonBuffer.write(JSON.stringify({ message: 2 }))
    jsonBuffer.write(JSON.stringify({ message: 3 }))
  })

  it('should call onFlush with the expected payload when the size is reached', function (done) {
    const expectedPayloads = [
      '[{"message":1},{"message":2}]',
      '[{"message":3},{"message":4}]'
    ]

    const onFlush = (json) => {
      expect(json).to.equal(expectedPayloads.shift())
      if (expectedPayloads.length === 0) done()
    }

    const jsonBuffer = new JSONBuffer({ size: 30, timeout: MAX_SAFE_SIGNED_INTEGER, onFlush })

    jsonBuffer.write(JSON.stringify({ message: 1 })) // size: 15
    jsonBuffer.write(JSON.stringify({ message: 2 })) // size: 29
    jsonBuffer.write(JSON.stringify({ message: 3 })) // size: 15 (flushed, and re-added)
    jsonBuffer.write(JSON.stringify({ message: 4 })) // size: 29
    jsonBuffer.write(JSON.stringify({ message: 5 })) // size: 15 (flushed, and re-added)
  })
})
