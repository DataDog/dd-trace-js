'use strict'

const t = require('tap')
require('../../../../dd-trace/test/setup/core')

const { expect } = require('chai')
const set = require('../../../src/utils/src/set')

t.test('set', t => {
  const obj = {}

  t.test('should set value at path', t => {
    set(obj, 'a', 1)
    set(obj, 'b.c', 2)
    set(obj, 'b.d.e', 3)
    expect(obj).to.deep.equal({ a: 1, b: { c: 2, d: { e: 3 } } })
    t.end()
  })
  t.end()
})
