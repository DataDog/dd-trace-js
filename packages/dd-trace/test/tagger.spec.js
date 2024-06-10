'use strict'

const constants = require('../src/constants')
require('./setup/tap')
const ERROR_MESSAGE = constants.ERROR_MESSAGE
const ERROR_STACK = constants.ERROR_STACK
const ERROR_TYPE = constants.ERROR_TYPE

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

  it('should set trace error', () => {
    tagger.add(carrier, {
      [ERROR_TYPE]: 'foo',
      [ERROR_MESSAGE]: 'foo',
      [ERROR_STACK]: 'foo'
    })

    expect(carrier).to.have.property(ERROR_TYPE, 'foo')
    expect(carrier).to.have.property(ERROR_MESSAGE, 'foo')
    expect(carrier).to.have.property(ERROR_STACK, 'foo')
    expect(carrier).to.have.property('setTraceError', true)

    tagger.add(carrier, {
      [ERROR_TYPE]: 'foo',
      [ERROR_MESSAGE]: 'foo',
      [ERROR_STACK]: 'foo',
      doNotSetTraceError: true
    })

    expect(carrier).to.have.property(ERROR_TYPE, 'foo')
    expect(carrier).to.have.property(ERROR_MESSAGE, 'foo')
    expect(carrier).to.have.property(ERROR_STACK, 'foo')
    expect(carrier).to.have.property('setTraceError', true)
  })
})
