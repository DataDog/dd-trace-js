'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('tap').mocha

require('../../../../dd-trace/test/setup/core')

const set = require('../../../src/utils/src/set')

describe('set', () => {
  const obj = {}

  it('should set value at path', () => {
    set(obj, 'a', 1)
    set(obj, 'b.c', 2)
    set(obj, 'b.d.e', 3)
    assert.deepStrictEqual(obj, { a: 1, b: { c: 2, d: { e: 3 } } })
  })
})
