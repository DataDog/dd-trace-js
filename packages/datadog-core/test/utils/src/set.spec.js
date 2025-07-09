'use strict'

require('../../../../dd-trace/test/setup/tap')

const { expect } = require('chai')
const set = require('../../../src/utils/src/set')

describe('set', () => {
  const obj = {}

  it('should set value at path', () => {
    set(obj, 'a', 1)
    set(obj, 'b.c', 2)
    set(obj, 'b.d.e', 3)
    expect(obj).to.deep.equal({ a: 1, b: { c: 2, d: { e: 3 } } })
  })
})
