'use strict'

const constants = require('../src/constants')
const t = require('tap')
require('./setup/core')
const ERROR_MESSAGE = constants.ERROR_MESSAGE
const ERROR_STACK = constants.ERROR_STACK
const ERROR_TYPE = constants.ERROR_TYPE

t.test('tagger', t => {
  let carrier
  let tagger

  t.beforeEach(() => {
    tagger = require('../src/tagger')
    carrier = {}
  })

  t.test('should add tags as an object', t => {
    tagger.add(carrier, { foo: 'bar' })

    expect(carrier).to.have.property('foo', 'bar')
    t.end()
  })

  t.test('should add tags as a string', t => {
    tagger.add(carrier, 'foo: bar,def,abc:,,baz:qux:quxx,  valid')

    expect(carrier).to.have.property('foo', 'bar')
    expect(carrier).to.have.property('baz', 'qux:quxx')
    expect(carrier).to.have.property('def', '')
    expect(carrier).to.have.property('abc', '')
    expect(carrier).to.not.have.property('')
    expect(carrier).to.have.property('valid', '')

    tagger.add(carrier, ':')

    expect(carrier).to.not.have.property('')
    t.end()
  })

  t.test('should not add empty tags', t => {
    tagger.add(carrier, '  ')

    expect(carrier).to.not.have.property('')

    tagger.add(carrier, 'a:true,\t')

    expect(carrier).to.have.property('a', 'true')
    expect(carrier).to.not.have.property('')

    tagger.add(carrier, 'a:true,')

    expect(carrier).to.have.property('a', 'true')
    expect(carrier).to.not.have.property('')
    t.end()
  })

  t.test('should add tags as an array', t => {
    tagger.add(carrier, ['foo:bar', 'baz:qux'])

    expect(carrier).to.have.property('foo', 'bar')
    expect(carrier).to.have.property('baz', 'qux')
    t.end()
  })

  t.test('should store the original values', t => {
    tagger.add(carrier, { foo: 123 })

    expect(carrier).to.have.property('foo', 123)
    t.end()
  })

  t.test('should handle missing key/value pairs', t => {
    expect(() => tagger.add(carrier)).not.to.throw()
    t.end()
  })

  t.test('should handle missing carrier', t => {
    expect(() => tagger.add()).not.to.throw()
    t.end()
  })

  t.test('should set trace error', t => {
    tagger.add(carrier, {
      [ERROR_TYPE]: 'foo',
      [ERROR_MESSAGE]: 'foo',
      [ERROR_STACK]: 'foo',
      doNotSetTraceError: true
    })

    expect(carrier).to.have.property(ERROR_TYPE, 'foo')
    expect(carrier).to.have.property(ERROR_MESSAGE, 'foo')
    expect(carrier).to.have.property(ERROR_STACK, 'foo')
    expect(carrier).to.have.property('doNotSetTraceError', true)
    expect(carrier).to.not.have.property('setTraceError')

    tagger.add(carrier, {
      [ERROR_TYPE]: 'foo',
      [ERROR_MESSAGE]: 'foo',
      [ERROR_STACK]: 'foo'
    })

    expect(carrier).to.have.property(ERROR_TYPE, 'foo')
    expect(carrier).to.have.property(ERROR_MESSAGE, 'foo')
    expect(carrier).to.have.property(ERROR_STACK, 'foo')
    expect(carrier).to.not.have.property('setTraceError')
    t.end()
  })
  t.end()
})
