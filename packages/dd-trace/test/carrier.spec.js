'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('./setup/core')
const { readList, readSingleton } = require('../src/carrier')

describe('carrier', () => {
  describe('readList', () => {
    const reads = [
      ['passes a scalar string through untouched', 'a=1', 'a=1'],
      ['reports an absent field as undefined', undefined, undefined],
      ['reports a non-string scalar as undefined so every caller can split it', 42, undefined],
      ['combines a repeated field with commas in wire order', ['a=1', 'b=2'], 'a=1,b=2'],
      ['unwraps a single-member repeat without adding a comma', ['a=1'], 'a=1'],
      ['reports an empty repeat as the empty string', [], ''],
      ['skips a non-string member instead of coercing it', ['a=1', Symbol('b'), 'c=3'], 'a=1,c=3'],
      ['keeps an empty member as an empty list element', ['', 'a=1'], ',a=1'],
      ['reports a repeat of only non-string members as the empty string', [42, null], ''],
    ]

    for (const [name, value, expected] of reads) {
      it(name, () => {
        assert.strictEqual(readList({ tracestate: value }, 'tracestate'), expected)
      })
    }
  })

  describe('readSingleton', () => {
    const reads = [
      ['passes a scalar string through untouched', '123', '123'],
      ['reports an absent field as undefined', undefined, undefined],
      ['passes a non-string scalar through for the caller to reject', 42, 42],
      ['resolves a repeated field to the last value the sender wrote', ['123', '456'], '456'],
      ['unwraps a single-member repeat', ['123'], '123'],
      ['reports an empty repeat as undefined', [], undefined],
      ['skips a trailing non-string member instead of coercing it', ['123', Symbol('x')], '123'],
      ['reports a repeat of only non-string members as undefined', [42, null], undefined],
    ]

    for (const [name, value, expected] of reads) {
      it(name, () => {
        assert.strictEqual(readSingleton({ 'x-datadog-trace-id': value }, 'x-datadog-trace-id'), expected)
      })
    }
  })
})
