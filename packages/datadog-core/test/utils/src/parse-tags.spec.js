'use strict'

const t = require('tap')
require('../../../../dd-trace/test/setup/core')

const parseTags = require('../../../src/utils/src/parse-tags')

t.test('parseTags', t => {
  t.test('should parse tags to object', t => {
    const obj = {
      'a.0.a': 'foo',
      'a.0.b': 'bar',
      'a.1.a': 'baz'
    }

    expect(parseTags(obj)).to.deep.equal({
      a: [{ a: 'foo', b: 'bar' }, { a: 'baz' }]
    })
    t.end()
  })

  t.test('should work with empty object', t => {
    expect(parseTags({})).to.deep.equal({})
    t.end()
  })
  t.end()
})
