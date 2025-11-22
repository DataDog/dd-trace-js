'use strict'

const assert = require('node:assert/strict')
const { describe, it, beforeEach } = require('tap').mocha

const constants = require('../src/constants')
require('./setup/core')
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

    assert.strictEqual(carrier.foo, 'bar')
  })

  it('should add tags as a string', () => {
    tagger.add(carrier, 'foo: bar,def,abc:,,baz:qux:quxx,  valid')

    assert.strictEqual(carrier.foo, 'bar')
    assert.strictEqual(carrier.baz, 'qux:quxx')
    assert.strictEqual(carrier.def, '')
    assert.strictEqual(carrier.abc, '')
    assert.ok(!Object.hasOwn(carrier, ''))
    assert.strictEqual(carrier.valid, '')

    tagger.add(carrier, ':')

    assert.ok(!Object.hasOwn(carrier, ''))
  })

  it('should not add empty tags', () => {
    tagger.add(carrier, '  ')

    assert.ok(!Object.hasOwn(carrier, ''))

    tagger.add(carrier, 'a:true,\t')

    assert.strictEqual(carrier.a, 'true')
    assert.ok(!Object.hasOwn(carrier, ''))

    tagger.add(carrier, 'a:true,')

    assert.strictEqual(carrier.a, 'true')
    assert.ok(!Object.hasOwn(carrier, ''))
  })

  it('should add tags as an array', () => {
    tagger.add(carrier, ['foo:bar', 'baz:qux'])

    assert.strictEqual(carrier.foo, 'bar')
    assert.strictEqual(carrier.baz, 'qux')
  })

  it('should store the original values', () => {
    tagger.add(carrier, { foo: 123 })

    assert.strictEqual(carrier.foo, 123)
  })

  it('should handle missing key/value pairs', () => {
    assert.doesNotThrow(() => tagger.add(carrier))
  })

  it('should handle missing carrier', () => {
    assert.doesNotThrow(() => tagger.add())
  })

  it('should set trace error', () => {
    tagger.add(carrier, {
      [ERROR_TYPE]: 'foo',
      [ERROR_MESSAGE]: 'foo',
      [ERROR_STACK]: 'foo',
      doNotSetTraceError: true
    })

    assert.strictEqual(carrier[ERROR_TYPE], 'foo')
    assert.strictEqual(carrier[ERROR_MESSAGE], 'foo')
    assert.strictEqual(carrier[ERROR_STACK], 'foo')
    assert.strictEqual(carrier.doNotSetTraceError, true)
    assert.ok(!Object.hasOwn(carrier, 'setTraceError'))

    tagger.add(carrier, {
      [ERROR_TYPE]: 'foo',
      [ERROR_MESSAGE]: 'foo',
      [ERROR_STACK]: 'foo'
    })

    assert.strictEqual(carrier[ERROR_TYPE], 'foo')
    assert.strictEqual(carrier[ERROR_MESSAGE], 'foo')
    assert.strictEqual(carrier[ERROR_STACK], 'foo')
    assert.ok(!Object.hasOwn(carrier, 'setTraceError'))
  })
})
