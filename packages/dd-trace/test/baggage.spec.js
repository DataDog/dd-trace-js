'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

require('./setup/core')
const { storage } = require('../../datadog-core')
const {
  setBaggageItem,
  setAllBaggageItems,
  getAllBaggageItems,
  removeAllBaggageItems,
} = require('../src/baggage')

describe('baggage', () => {
  let enterWith

  beforeEach(() => {
    removeAllBaggageItems()
    enterWith = sinon.spy(storage('baggage'), 'enterWith')
  })

  afterEach(() => {
    enterWith.restore()
    storage('baggage').enterWith(undefined)
  })

  describe('removeAllBaggageItems', () => {
    it('does not call enterWith when no store has been entered yet', () => {
      storage('baggage').enterWith(undefined)
      enterWith.resetHistory()

      removeAllBaggageItems()

      sinon.assert.notCalled(enterWith)
      assert.deepStrictEqual(getAllBaggageItems(), {})
    })

    it('does not call enterWith when the store is already the empty sentinel', () => {
      removeAllBaggageItems()
      enterWith.resetHistory()

      removeAllBaggageItems()

      sinon.assert.notCalled(enterWith)
    })

    it('calls enterWith once to clear a non-empty store', () => {
      setBaggageItem('foo', 'bar')
      assert.deepStrictEqual(getAllBaggageItems(), { foo: 'bar' })
      enterWith.resetHistory()

      removeAllBaggageItems()

      sinon.assert.calledOnce(enterWith)
      assert.deepStrictEqual(getAllBaggageItems(), {})
    })

    it('calls enterWith when the store is a separate empty object', () => {
      setAllBaggageItems({})
      enterWith.resetHistory()

      removeAllBaggageItems()

      sinon.assert.calledOnce(enterWith)
      assert.deepStrictEqual(getAllBaggageItems(), {})
    })

    it('returns the frozen empty sentinel', () => {
      const first = removeAllBaggageItems()
      const second = removeAllBaggageItems()

      assert.strictEqual(first, second)
      assert.ok(Object.isFrozen(first))
      assert.deepStrictEqual(first, {})
    })
  })
})
