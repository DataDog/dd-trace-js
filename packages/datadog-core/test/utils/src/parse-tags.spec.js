'use strict'

const { expect } = require('chai')
const { describe, it } = require('tap').mocha

require('../../../../dd-trace/test/setup/tap')

const parseTags = require('../../../src/utils/src/parse-tags')

describe('parseTags', () => {
  it('should parse tags to object', () => {
    const obj = {
      'a.0.a': 'foo',
      'a.0.b': 'bar',
      'a.1.a': 'baz'
    }

    expect(parseTags(obj)).to.deep.equal({
      a: [{ a: 'foo', b: 'bar' }, { a: 'baz' }]
    })
  })

  it('should work with empty object', () => {
    expect(parseTags({})).to.deep.equal({})
  })
})
