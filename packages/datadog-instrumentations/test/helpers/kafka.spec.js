'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')

const { cloneMessages } = require('../../src/helpers/kafka')

describe('helpers/kafka', () => {
  describe('cloneMessages', () => {
    it('returns a fresh array; the input is not the output', () => {
      const input = [{ key: 'k', value: 'v' }]
      const output = cloneMessages(input, false)
      assert.notStrictEqual(output, input)
      assert.notStrictEqual(output[0], input[0])
    })

    it('keeps the headers field absent when ensureHeaders is false and input has none', () => {
      const input = [{ key: 'k', value: 'v' }]
      const [cloned] = cloneMessages(input, false)
      assert.strictEqual(Object.hasOwn(cloned, 'headers'), false)
      assert.strictEqual(input[0].headers, undefined)
    })

    it('seeds an empty headers object when ensureHeaders is true and input has none', () => {
      const input = [{ key: 'k', value: 'v' }]
      const [cloned] = cloneMessages(input, true)
      assert.deepStrictEqual(cloned.headers, {})
      assert.strictEqual(input[0].headers, undefined)
    })

    it('shallow-clones existing headers so caller mutations stay isolated', () => {
      const headers = { foo: 'bar' }
      const [withHeaders] = cloneMessages([{ key: 'k', value: 'v', headers }], false)
      const [withInjection] = cloneMessages([{ key: 'k', value: 'v', headers }], true)
      assert.notStrictEqual(withHeaders.headers, headers)
      assert.notStrictEqual(withInjection.headers, headers)
      assert.deepStrictEqual(withHeaders.headers, headers)
      assert.deepStrictEqual(withInjection.headers, headers)
    })

    it('passes non-object entries through unchanged regardless of ensureHeaders', () => {
      const sentinel = Symbol('not-a-message')
      const input = [null, sentinel, 0, '']
      assert.deepStrictEqual(cloneMessages(input, false), [null, sentinel, 0, ''])
      assert.deepStrictEqual(cloneMessages(input, true), [null, sentinel, 0, ''])
    })
  })
})
