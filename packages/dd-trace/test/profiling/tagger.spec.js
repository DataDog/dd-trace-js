'use strict'

const t = require('tap')
require('../setup/core')

const { expect } = require('chai')

t.test('tagger', t => {
  let tagger

  t.beforeEach(() => {
    tagger = require('../../src/profiling/tagger').tagger
  })

  t.test('should default to an empty object', t => {
    const parsed = tagger.parse()

    expect(parsed).to.deep.equal({})
    t.end()
  })

  t.test('should default to an empty object for invalid values', t => {
    const parsed = tagger.parse(1234)

    expect(parsed).to.deep.equal({})
    t.end()
  })

  t.test('should support objects', t => {
    const tags = {
      foo: 'bar',
      baz: 'qux',
      undefined,
      null: null
    }

    const parsed = tagger.parse(tags)

    expect(parsed).to.deep.equal({
      foo: 'bar',
      baz: 'qux'
    })
    t.end()
  })

  t.test('should support strings', t => {
    const tags = 'foo:bar,baz:qux'
    const parsed = tagger.parse(tags)

    expect(parsed).to.deep.equal({
      foo: 'bar',
      baz: 'qux'
    })
    t.end()
  })

  t.test('should support an array of strings', t => {
    const tags = ['foo:bar', 'baz:qux']
    const parsed = tagger.parse(tags)

    expect(parsed).to.deep.equal({
      foo: 'bar',
      baz: 'qux'
    })
    t.end()
  })

  t.test('should support values that include the delimiter', t => {
    const tags = 'foo:bar:baz'
    const parsed = tagger.parse(tags)

    expect(parsed).to.deep.equal({
      foo: 'bar:baz'
    })
    t.end()
  })

  t.test('should ignore empty keys in strings', t => {
    const tags = ':bar'
    const parsed = tagger.parse(tags)

    expect(parsed).to.deep.equal({})
    t.end()
  })

  t.test('should ignore empty values in strings', t => {
    const tags = 'foo:'
    const parsed = tagger.parse(tags)

    expect(parsed).to.deep.equal({})
    t.end()
  })

  t.test('should ignore empty values in strings', t => {
    const tags = 'foo:'
    const parsed = tagger.parse(tags)

    expect(parsed).to.deep.equal({})
    t.end()
  })

  t.test('should trim whitespace around keys and values', t => {
    const tags = 'foo:bar, fruit:banana'
    const parsed = tagger.parse(tags)

    expect(parsed).to.deep.equal({
      foo: 'bar',
      fruit: 'banana'
    })
    t.end()
  })
  t.end()
})
