'use strict'

require('./setup/tap')

describe('tagger', () => {
  let carrier
  let tagger

  beforeEach(() => {
    tagger = require('../src/tagger')
    carrier = {}
  })

  it('should add tags as an object', () => {
    tagger.add(carrier, { foo: 'bar' })

    expect(carrier).to.have.property('foo', 'bar')
  })

  it('should add tags as a string', () => {
    tagger.add(carrier, 'foo:bar,baz:qux:quxx,invalid')

    expect(carrier).to.have.property('foo', 'bar')
    expect(carrier).to.have.property('baz', 'qux:quxx')
    expect(carrier).to.not.have.property('invalid')
  })

  it('should add tags as an array', () => {
    tagger.add(carrier, ['foo:bar', 'baz:qux'])

    expect(carrier).to.have.property('foo', 'bar')
    expect(carrier).to.have.property('baz', 'qux')
  })

  it('should store the original values', () => {
    tagger.add(carrier, { foo: 123 })

    expect(carrier).to.have.property('foo', 123)
  })

  it('should handle missing key/value pairs', () => {
    expect(() => tagger.add(carrier)).not.to.throw()
  })

  it('should handle missing carrier', () => {
    expect(() => tagger.add()).not.to.throw()
  })
})
