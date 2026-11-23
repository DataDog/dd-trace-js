'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('aiguard/messages/utils', () => {
  describe('decode', () => {
    for (const thrown of [null, undefined, 'text']) {
      it(`logs a thrown ${JSON.stringify(thrown) ?? 'undefined'} and returns the fallback`, () => {
        const log = { debug: sinon.stub(), error: sinon.stub() }
        const { decode } = proxyquire('../../../src/aiguard/messages/utils', { '../../log': log })
        const fallback = []

        const result = decode(() => { throw thrown }, fallback, 'AIGuard: unable to decode: %s')

        assert.strictEqual(result, fallback)
        sinon.assert.calledOnceWithExactly(log.error, 'AIGuard: unable to decode: %s', undefined)
      })
    }

    it('logs the message of a thrown Error and returns the fallback', () => {
      const log = { debug: sinon.stub(), error: sinon.stub() }
      const { decode } = proxyquire('../../../src/aiguard/messages/utils', { '../../log': log })

      const result = decode(() => { throw new Error('bad payload') }, null, 'AIGuard: unable to decode: %s')

      assert.strictEqual(result, null)
      sinon.assert.calledOnceWithExactly(log.error, 'AIGuard: unable to decode: %s', 'bad payload')
    })
  })
})
