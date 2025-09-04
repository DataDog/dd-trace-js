'use strict'

const { expect } = require('chai')
const { describe, it } = require('tap').mocha

require('./setup/core')

const {
  PAYLOAD_TAG_REQUEST_PREFIX,
  PAYLOAD_TAG_RESPONSE_PREFIX
} = require('../src/constants')
const { tagsFromObject } = require('../src/payload-tagging/tagging')
const { computeTags } = require('../src/payload-tagging')

const defaultOpts = { maxDepth: 10, prefix: 'http.payload' }

describe('Payload tagger', () => {
  describe('tag count cutoff', () => {
    it('should generate many tags when not reaching the cap', () => {
      const belowCap = 200
      const input = { foo: Object.fromEntries([...Array(belowCap).keys()].map(i => [i, i])) }
      const tagCount = Object.entries(tagsFromObject(input, defaultOpts)).length
      expect(tagCount).to.equal(belowCap)
    })

    it('should stop generating tags once the cap is reached', () => {
      const aboveCap = 759
      const input = { foo: Object.fromEntries([...Array(aboveCap).keys()].map(i => [i, i])) }
      const tagCount = Object.entries(tagsFromObject(input, defaultOpts)).length
      expect(tagCount).to.not.equal(aboveCap)
      expect(tagCount).to.equal(758)
    })
  })

  describe('best-effort redacting of keys', () => {
    it('should redact disallowed keys', () => {
      const input = {
        foo: {
          bar: {
            token: 'tokenpleaseredact',
            authorization: 'pleaseredact',
            valid: 'valid'
          },
          baz: {
            password: 'shouldgo',
            'x-authorization': 'shouldbegone',
            data: 'shouldstay'
          }
        }
      }
      const tags = tagsFromObject(input, defaultOpts)
      expect(tags).to.deep.equal({
        'http.payload.foo.bar.token': 'redacted',
        'http.payload.foo.bar.authorization': 'redacted',
        'http.payload.foo.bar.valid': 'valid',
        'http.payload.foo.baz.password': 'redacted',
        'http.payload.foo.baz.x-authorization': 'redacted',
        'http.payload.foo.baz.data': 'shouldstay'
      })
    })

    it('should redact banned keys even if they are objects', () => {
      const input = {
        foo: {
          authorization: {
            token: 'tokenpleaseredact',
            authorization: 'pleaseredact',
            valid: 'valid'
          },
          baz: {
            password: 'shouldgo',
            'x-authorization': 'shouldbegone',
            data: 'shouldstay'
          }
        }
      }
      const tags = tagsFromObject(input, defaultOpts)
      expect(tags).to.deep.equal({
        'http.payload.foo.authorization': 'redacted',
        'http.payload.foo.baz.password': 'redacted',
        'http.payload.foo.baz.x-authorization': 'redacted',
        'http.payload.foo.baz.data': 'shouldstay'
      })
    })
  })

  describe('escaping', () => {
    it('should escape `.` characters in individual keys', () => {
      const input = { 'foo.bar': { baz: 'quux' } }
      const tags = tagsFromObject(input, defaultOpts)
      expect(tags).to.deep.equal({
        'http.payload.foo\\.bar.baz': 'quux'
      })
    })
  })

  describe('parsing', () => {
    it('should transform null values to "null" string', () => {
      const input = { foo: 'bar', baz: null }
      const tags = tagsFromObject(input, defaultOpts)
      expect(tags).to.deep.equal({
        'http.payload.foo': 'bar',
        'http.payload.baz': 'null'
      })
    })

    it('should transform undefined values to "undefined" string', () => {
      const input = { foo: 'bar', baz: undefined }
      const tags = tagsFromObject(input, defaultOpts)
      expect(tags).to.deep.equal({
        'http.payload.foo': 'bar',
        'http.payload.baz': 'undefined'
      })
    })

    it('should transform boolean values to strings', () => {
      const input = { foo: true, bar: false }
      const tags = tagsFromObject(input, defaultOpts)
      expect(tags).to.deep.equal({
        'http.payload.foo': 'true',
        'http.payload.bar': 'false'
      })
    })

    it('should decode buffers as UTF-8', () => {
      const input = { foo: Buffer.from('bar') }
      const tags = tagsFromObject(input, defaultOpts)
      expect(tags).to.deep.equal({ 'http.payload.foo': 'bar' })
    })

    it('should provide tags from simple JSON objects, casting to strings where necessary', () => {
      const input = {
        foo: { bar: { baz: 1, quux: 2 } },
        asimplestring: 'isastring',
        anullvalue: null,
        anundefined: undefined
      }
      const tags = tagsFromObject(input, defaultOpts)
      expect(tags).to.deep.equal({
        'http.payload.foo.bar.baz': '1',
        'http.payload.foo.bar.quux': '2',
        'http.payload.asimplestring': 'isastring',
        'http.payload.anullvalue': 'null',
        'http.payload.anundefined': 'undefined'
      })
    })

    it('should index tags when encountering arrays', () => {
      const input = { foo: { bar: { list: ['v0', 'v1', 'v2'] } } }
      const tags = tagsFromObject(input, defaultOpts)
      expect(tags).to.deep.equal({
        'http.payload.foo.bar.list.0': 'v0',
        'http.payload.foo.bar.list.1': 'v1',
        'http.payload.foo.bar.list.2': 'v2'
      })
    })

    it('should not replace a real value at max depth', () => {
      const input = {
        1: { 2: { 3: { 4: { 5: { 6: { 7: { 8: { 9: { 10: 11 } } } } } } } } }
      }
      const tags = tagsFromObject(input, defaultOpts)
      expect(tags).to.deep.equal({ 'http.payload.1.2.3.4.5.6.7.8.9.10': '11' })
    })

    it('should truncate paths beyond max depth', () => {
      const input = {
        1: { 2: { 3: { 4: { 5: { 6: { 7: { 8: { 9: { 10: { 11: 'too much' } } } } } } } } } }
      }
      const tags = tagsFromObject(input, defaultOpts)
      expect(tags).to.deep.equal({ 'http.payload.1.2.3.4.5.6.7.8.9.10': 'truncated' })
    })
  })
})

describe('Tagging orchestration', () => {
  it('should use the request config when given the request prefix', () => {
    const config = {
      request: ['$.request'],
      response: ['$.response'],
      expand: []
    }
    const input = {
      request: 'foo',
      response: 'bar'
    }
    const tags = computeTags(config, input, { maxDepth: 10, prefix: PAYLOAD_TAG_REQUEST_PREFIX })
    expect(tags).to.have.property(`${PAYLOAD_TAG_REQUEST_PREFIX}.request`, 'redacted')
    expect(tags).to.have.property(`${PAYLOAD_TAG_REQUEST_PREFIX}.response`, 'bar')
  })

  it('should use the response config when given the response prefix', () => {
    const config = {
      request: ['$.request'],
      response: ['$.response'],
      expand: []
    }
    const input = {
      request: 'foo',
      response: 'bar'
    }
    const tags = computeTags(config, input, { maxDepth: 10, prefix: PAYLOAD_TAG_RESPONSE_PREFIX })
    expect(tags).to.have.property(`${PAYLOAD_TAG_RESPONSE_PREFIX}.response`, 'redacted')
    expect(tags).to.have.property(`${PAYLOAD_TAG_RESPONSE_PREFIX}.request`, 'foo')
  })

  it('should apply expansion rules', () => {
    const config = {
      request: [],
      response: [],
      expand: ['$.request', '$.response', '$.invalid']
    }
    const input = {
      request: '{ "foo": "bar" }',
      response: '{ "baz": "quux" }',
      invalid: '{ invalid JSON }',
      untargeted: '{ "foo": "bar" }'
    }
    const tags = computeTags(config, input, { maxDepth: 10, prefix: 'foo' })
    expect(tags).to.have.property('foo.request.foo', 'bar')
    expect(tags).to.have.property('foo.response.baz', 'quux')
    expect(tags).to.have.property('foo.invalid', '{ invalid JSON }')
    expect(tags).to.have.property('foo.untargeted', '{ "foo": "bar" }')
  })
})
