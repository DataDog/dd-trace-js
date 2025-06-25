const t = require('tap')
require('./setup/core')

const {
  PAYLOAD_TAG_REQUEST_PREFIX,
  PAYLOAD_TAG_RESPONSE_PREFIX
} = require('../src/constants')
const { tagsFromObject } = require('../src/payload-tagging/tagging')
const { computeTags } = require('../src/payload-tagging')

const { expect } = require('chai')

const defaultOpts = { maxDepth: 10, prefix: 'http.payload' }

t.test('Payload tagger', t => {
  t.test('tag count cutoff', t => {
    t.test('should generate many tags when not reaching the cap', t => {
      const belowCap = 200
      const input = { foo: Object.fromEntries([...Array(belowCap).keys()].map(i => [i, i])) }
      const tagCount = Object.entries(tagsFromObject(input, defaultOpts)).length
      expect(tagCount).to.equal(belowCap)
      t.end()
    })

    t.test('should stop generating tags once the cap is reached', t => {
      const aboveCap = 759
      const input = { foo: Object.fromEntries([...Array(aboveCap).keys()].map(i => [i, i])) }
      const tagCount = Object.entries(tagsFromObject(input, defaultOpts)).length
      expect(tagCount).to.not.equal(aboveCap)
      expect(tagCount).to.equal(758)
      t.end()
    })
    t.end()
  })

  t.test('best-effort redacting of keys', t => {
    t.test('should redact disallowed keys', t => {
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
      t.end()
    })

    t.test('should redact banned keys even if they are objects', t => {
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
      t.end()
    })
    t.end()
  })

  t.test('escaping', t => {
    t.test('should escape `.` characters in individual keys', t => {
      const input = { 'foo.bar': { baz: 'quux' } }
      const tags = tagsFromObject(input, defaultOpts)
      expect(tags).to.deep.equal({
        'http.payload.foo\\.bar.baz': 'quux'
      })
      t.end()
    })
    t.end()
  })

  t.test('parsing', t => {
    t.test('should transform null values to "null" string', t => {
      const input = { foo: 'bar', baz: null }
      const tags = tagsFromObject(input, defaultOpts)
      expect(tags).to.deep.equal({
        'http.payload.foo': 'bar',
        'http.payload.baz': 'null'
      })
      t.end()
    })

    t.test('should transform undefined values to "undefined" string', t => {
      const input = { foo: 'bar', baz: undefined }
      const tags = tagsFromObject(input, defaultOpts)
      expect(tags).to.deep.equal({
        'http.payload.foo': 'bar',
        'http.payload.baz': 'undefined'
      })
      t.end()
    })

    t.test('should transform boolean values to strings', t => {
      const input = { foo: true, bar: false }
      const tags = tagsFromObject(input, defaultOpts)
      expect(tags).to.deep.equal({
        'http.payload.foo': 'true',
        'http.payload.bar': 'false'
      })
      t.end()
    })

    t.test('should decode buffers as UTF-8', t => {
      const input = { foo: Buffer.from('bar') }
      const tags = tagsFromObject(input, defaultOpts)
      expect(tags).to.deep.equal({ 'http.payload.foo': 'bar' })
      t.end()
    })

    t.test('should provide tags from simple JSON objects, casting to strings where necessary', t => {
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
      t.end()
    })

    t.test('should index tags when encountering arrays', t => {
      const input = { foo: { bar: { list: ['v0', 'v1', 'v2'] } } }
      const tags = tagsFromObject(input, defaultOpts)
      expect(tags).to.deep.equal({
        'http.payload.foo.bar.list.0': 'v0',
        'http.payload.foo.bar.list.1': 'v1',
        'http.payload.foo.bar.list.2': 'v2'
      })
      t.end()
    })

    t.test('should not replace a real value at max depth', t => {
      const input = {
        1: { 2: { 3: { 4: { 5: { 6: { 7: { 8: { 9: { 10: 11 } } } } } } } } }
      }
      const tags = tagsFromObject(input, defaultOpts)
      expect(tags).to.deep.equal({ 'http.payload.1.2.3.4.5.6.7.8.9.10': '11' })
      t.end()
    })

    t.test('should truncate paths beyond max depth', t => {
      const input = {
        1: { 2: { 3: { 4: { 5: { 6: { 7: { 8: { 9: { 10: { 11: 'too much' } } } } } } } } } }
      }
      const tags = tagsFromObject(input, defaultOpts)
      expect(tags).to.deep.equal({ 'http.payload.1.2.3.4.5.6.7.8.9.10': 'truncated' })
      t.end()
    })
    t.end()
  })
  t.end()
})

t.test('Tagging orchestration', t => {
  t.test('should use the request config when given the request prefix', t => {
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
    t.end()
  })

  t.test('should use the response config when given the response prefix', t => {
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
    t.end()
  })

  t.test('should apply expansion rules', t => {
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
    t.end()
  })
  t.end()
})
