'use strict'

require('../setup/core')

const { expect } = require('chai')

describe('tagger', () => {
  let tagger

  beforeEach(() => {
    tagger = require('../../src/profiling/tagger').tagger
  })

  it('should default to an empty object', () => {
    const parsed = tagger.parse()

    expect(parsed).to.deep.equal({})
  })

  it('should default to an empty object for invalid values', () => {
    const parsed = tagger.parse(1234)

    expect(parsed).to.deep.equal({})
  })

  it('should support objects', () => {
    const tags = {
      foo: 'bar',
      baz: 'qux',
      undefined: undefined,
      null: null
    }

    const parsed = tagger.parse(tags)

    expect(parsed).to.deep.equal({
      foo: 'bar',
      baz: 'qux'
    })
  })

  it('should support strings', () => {
    const tags = 'foo:bar,baz:qux'
    const parsed = tagger.parse(tags)

    expect(parsed).to.deep.equal({
      foo: 'bar',
      baz: 'qux'
    })
  })

  it('should support an array of strings', () => {
    const tags = ['foo:bar', 'baz:qux']
    const parsed = tagger.parse(tags)

    expect(parsed).to.deep.equal({
      foo: 'bar',
      baz: 'qux'
    })
  })

  it('should support values that include the delimiter', () => {
    const tags = 'foo:bar:baz'
    const parsed = tagger.parse(tags)

    expect(parsed).to.deep.equal({
      foo: 'bar:baz'
    })
  })

  it('should ignore empty keys in strings', () => {
    const tags = ':bar'
    const parsed = tagger.parse(tags)

    expect(parsed).to.deep.equal({})
  })

  it('should ignore empty values in strings', () => {
    const tags = 'foo:'
    const parsed = tagger.parse(tags)

    expect(parsed).to.deep.equal({})
  })

  it('should ignore empty values in strings', () => {
    const tags = 'foo:'
    const parsed = tagger.parse(tags)

    expect(parsed).to.deep.equal({})
  })

  it('should trim whitespace around keys and values', () => {
    const tags = 'foo:bar, fruit:banana'
    const parsed = tagger.parse(tags)

    expect(parsed).to.deep.equal({
      foo: 'bar',
      fruit: 'banana'
    })
  })
})
