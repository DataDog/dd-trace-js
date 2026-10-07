'use strict'

const assert = require('node:assert/strict')
const { Readable } = require('node:stream')
const {
  PAYLOAD_TAG_REQUEST_PREFIX,
  PAYLOAD_TAG_RESPONSE_PREFIX,
} = require('../../src/constants')
const { tagsFromObject } = require('../../src/payload-tagging/tagging')
const { computeTags } = require('../../src/payload-tagging')
const { assertObjectContains } = require('../../../../integration-tests/helpers')

const defaultOpts = { maxDepth: 10, prefix: 'http.payload' }

describe('Payload tagger', () => {
  describe('tag count cutoff', () => {
    it('should generate many tags when not reaching the cap', () => {
      const belowCap = 200
      const input = { foo: Object.fromEntries([...Array(belowCap).keys()].map(i => [i, i])) }
      const tagCount = Object.entries(tagsFromObject(input, defaultOpts)).length
      assert.strictEqual(tagCount, belowCap)
    })

    it('should stop generating tags once the cap is reached', () => {
      const aboveCap = 759
      const input = { foo: Object.fromEntries([...Array(aboveCap).keys()].map(i => [i, i])) }
      const tagCount = Object.entries(tagsFromObject(input, defaultOpts)).length
      assert.notStrictEqual(tagCount, aboveCap)
      assert.strictEqual(tagCount, 758)
    })
  })

  describe('best-effort redacting of keys', () => {
    it('should redact disallowed keys', () => {
      const input = {
        foo: {
          bar: {
            token: 'tokenpleaseredact',
            authorization: 'pleaseredact',
            valid: 'valid',
          },
          baz: {
            password: 'shouldgo',
            'x-authorization': 'shouldbegone',
            data: 'shouldstay',
          },
        },
      }
      const tags = tagsFromObject(input, defaultOpts)
      assert.deepStrictEqual(tags, {
        'http.payload.foo.bar.token': 'redacted',
        'http.payload.foo.bar.authorization': 'redacted',
        'http.payload.foo.bar.valid': 'valid',
        'http.payload.foo.baz.password': 'redacted',
        'http.payload.foo.baz.x-authorization': 'redacted',
        'http.payload.foo.baz.data': 'shouldstay',
      })
    })

    it('should redact banned keys even if they are objects', () => {
      const input = {
        foo: {
          authorization: {
            token: 'tokenpleaseredact',
            authorization: 'pleaseredact',
            valid: 'valid',
          },
          baz: {
            password: 'shouldgo',
            'x-authorization': 'shouldbegone',
            data: 'shouldstay',
          },
        },
      }
      const tags = tagsFromObject(input, defaultOpts)
      assert.deepStrictEqual(tags, {
        'http.payload.foo.authorization': 'redacted',
        'http.payload.foo.baz.password': 'redacted',
        'http.payload.foo.baz.x-authorization': 'redacted',
        'http.payload.foo.baz.data': 'shouldstay',
      })
    })
  })

  describe('escaping', () => {
    it('should escape `.` characters in individual keys', () => {
      const input = { 'foo.bar': { baz: 'quux' } }
      const tags = tagsFromObject(input, defaultOpts)
      assert.deepStrictEqual(tags, {
        'http.payload.foo\\.bar.baz': 'quux',
      })
    })
  })

  describe('parsing', () => {
    it('should transform null values to "null" string', () => {
      const input = { foo: 'bar', baz: null }
      const tags = tagsFromObject(input, defaultOpts)
      assert.deepStrictEqual(tags, {
        'http.payload.foo': 'bar',
        'http.payload.baz': 'null',
      })
    })

    it('should transform undefined values to "undefined" string', () => {
      const input = { foo: 'bar', baz: undefined }
      const tags = tagsFromObject(input, defaultOpts)
      assert.deepStrictEqual(tags, {
        'http.payload.foo': 'bar',
        'http.payload.baz': 'undefined',
      })
    })

    it('should transform boolean values to strings', () => {
      const input = { foo: true, bar: false }
      const tags = tagsFromObject(input, defaultOpts)
      assert.deepStrictEqual(tags, {
        'http.payload.foo': 'true',
        'http.payload.bar': 'false',
      })
    })

    it('should decode buffers as UTF-8', () => {
      const input = { foo: Buffer.from('bar') }
      const tags = tagsFromObject(input, defaultOpts)
      assert.deepStrictEqual(tags, { 'http.payload.foo': 'bar' })
    })

    it('should truncate long strings and buffers', () => {
      for (const length of [5000, 5001, 10_000, 10_001]) {
        const value = 'x'.repeat(length)
        const tags = tagsFromObject({ string: value, buffer: Buffer.from(value) }, defaultOpts)
        assert.deepStrictEqual(tags, {
          'http.payload.string': 'x'.repeat(5000),
          'http.payload.buffer': 'x'.repeat(5000),
        })
      }
    })

    it('should provide tags from simple JSON objects, casting to strings where necessary', () => {
      const input = {
        foo: { bar: { baz: 1, quux: 2 } },
        asimplestring: 'isastring',
        anullvalue: null,
        anundefined: undefined,
      }
      const tags = tagsFromObject(input, defaultOpts)
      assert.deepStrictEqual(tags, {
        'http.payload.foo.bar.baz': '1',
        'http.payload.foo.bar.quux': '2',
        'http.payload.asimplestring': 'isastring',
        'http.payload.anullvalue': 'null',
        'http.payload.anundefined': 'undefined',
      })
    })

    it('should index tags when encountering arrays', () => {
      const input = { foo: { bar: { list: ['v0', 'v1', 'v2'] } } }
      const tags = tagsFromObject(input, defaultOpts)
      assert.deepStrictEqual(tags, {
        'http.payload.foo.bar.list.0': 'v0',
        'http.payload.foo.bar.list.1': 'v1',
        'http.payload.foo.bar.list.2': 'v2',
      })
    })

    it('should not replace a real value at max depth', () => {
      const input = {
        1: { 2: { 3: { 4: { 5: { 6: { 7: { 8: { 9: { 10: 11 } } } } } } } } },
      }
      const tags = tagsFromObject(input, defaultOpts)
      assert.deepStrictEqual(tags, { 'http.payload.1.2.3.4.5.6.7.8.9.10': '11' })
    })

    it('should truncate paths beyond max depth', () => {
      const input = {
        1: { 2: { 3: { 4: { 5: { 6: { 7: { 8: { 9: { 10: { 11: 'too much' } } } } } } } } } },
      }
      const tags = tagsFromObject(input, defaultOpts)
      assert.deepStrictEqual(tags, { 'http.payload.1.2.3.4.5.6.7.8.9.10': 'truncated' })
    })
  })
})

describe('Tagging orchestration', () => {
  it('should use the request config when given the request prefix', () => {
    const config = {
      request: ['$.request'],
      response: ['$.response'],
      expand: [],
    }
    const input = {
      request: 'foo',
      response: 'bar',
    }
    const tags = computeTags(config, input, { maxDepth: 10, prefix: PAYLOAD_TAG_REQUEST_PREFIX })
    assert.strictEqual(tags[`${PAYLOAD_TAG_REQUEST_PREFIX}.request`], 'redacted')
    assert.strictEqual(tags[`${PAYLOAD_TAG_REQUEST_PREFIX}.response`], 'bar')
  })

  it('should use the response config when given the response prefix', () => {
    const config = {
      request: ['$.request'],
      response: ['$.response'],
      expand: [],
    }
    const input = {
      request: 'foo',
      response: 'bar',
    }
    const tags = computeTags(config, input, { maxDepth: 10, prefix: PAYLOAD_TAG_RESPONSE_PREFIX })
    assert.strictEqual(tags[`${PAYLOAD_TAG_RESPONSE_PREFIX}.response`], 'redacted')
    assert.strictEqual(tags[`${PAYLOAD_TAG_RESPONSE_PREFIX}.request`], 'foo')
  })

  it('should not fail if the response config contains invalid config', () => {
    const config = {
      request: ['invalid,request'],
      response: ['invalid,$.foo,$.response'],
      expand: [],
    }
    const input = {
      request: 'foo',
      response: 'bar',
    }
    const tags = computeTags(config, input, { maxDepth: 10, prefix: PAYLOAD_TAG_RESPONSE_PREFIX })
    assert.strictEqual(tags[`${PAYLOAD_TAG_RESPONSE_PREFIX}.response`], 'redacted')
    assert.strictEqual(tags[`${PAYLOAD_TAG_RESPONSE_PREFIX}.request`], 'foo')
  })

  it('should apply expansion rules with dollar identical to an empty input', () => {
    const config = {
      request: ['$'],
      response: ['$'],
      expand: ['$.request', '$.response', '$.invalid'],
    }
    const input = {
      request: '{ "foo": "bar" }',
      response: '{ "baz": "quux" }',
      invalid: '{ invalid JSON }',
      untargeted: '{ "foo": "bar" }',
    }
    const tags = computeTags(config, input, { maxDepth: 10, prefix: 'foo' })
    assertObjectContains(tags, {
      'foo.request.foo': 'bar',
      'foo.response.baz': 'quux',
      'foo.invalid': '{ invalid JSON }',
      'foo.untargeted': '{ "foo": "bar" }',
    })
  })

  it('should apply expansion rules', () => {
    const config = {
      request: [],
      response: [],
      expand: ['$.request', '$.response', '$.invalid'],
    }
    const input = {
      request: '{ "foo": "bar" }',
      response: '{ "baz": "quux" }',
      invalid: '{ invalid JSON }',
      untargeted: '{ "foo": "bar" }',
    }
    const tags = computeTags(config, input, { maxDepth: 10, prefix: 'foo' })
    assertObjectContains(tags, {
      'foo.request.foo': 'bar',
      'foo.response.baz': 'quux',
      'foo.invalid': '{ invalid JSON }',
      'foo.untargeted': '{ "foo": "bar" }',
    })
  })
})

describe('Safe payload capture', () => {
  const safeConfig = { expand: [], request: [], response: [] }
  const responseOpts = { maxDepth: 10, prefix: PAYLOAD_TAG_RESPONSE_PREFIX }

  function makeReadable () {
    const stream = new Readable({ read () {} })
    stream.push(Buffer.from('chunk'))
    return stream
  }

  function deepFreeze (value) {
    if (value !== null && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        deepFreeze(value[key])
      }
      Object.freeze(value)
    }
    return value
  }

  it('should replace a Node.js stream with "truncated" and retain sibling metadata', () => {
    const stream = makeReadable()
    const input = { ETag: '"etag"', Body: stream, ContentLength: 5 }

    const tags = computeTags(safeConfig, input, responseOpts)

    assert.deepStrictEqual(tags, {
      'aws.response.body.ETag': '"etag"',
      'aws.response.body.Body': 'truncated',
      'aws.response.body.ContentLength': '5',
      '_dd.payload_tags_incomplete': true,
    })
    assert.strictEqual(stream.readableLength, 5)
    assert.strictEqual(stream.readableFlowing, null)
    assert.strictEqual(stream.listenerCount('data'), 0)
    assert.strictEqual(stream.destroyed, false)
    assert.deepStrictEqual(stream.read(), Buffer.from('chunk'))
  })

  it('should replace a web ReadableStream with "truncated" without locking it', async () => {
    const stream = new ReadableStream({
      start (controller) {
        controller.enqueue('a')
        controller.enqueue('b')
        controller.close()
      },
    })
    const input = { Body: stream, Ok: true }

    const tags = computeTags(safeConfig, input, responseOpts)

    assert.strictEqual(tags['aws.response.body.Body'], 'truncated')
    assert.strictEqual(tags['aws.response.body.Ok'], 'true')
    assert.strictEqual(stream.locked, false)

    const reader = stream.getReader()
    assert.deepStrictEqual(await reader.read(), { value: 'a', done: false })
    assert.deepStrictEqual(await reader.read(), { value: 'b', done: false })
    assert.deepStrictEqual(await reader.read(), { value: undefined, done: true })
  })

  it('should replace cyclic back-references with "truncated"', () => {
    const direct = { name: 'direct' }
    direct.self = direct

    assert.deepStrictEqual(computeTags(safeConfig, direct, responseOpts), {
      'aws.response.body.name': 'direct',
      'aws.response.body.self': 'truncated',
      '_dd.payload_tags_incomplete': true,
    })

    const indirect = { name: 'indirect' }
    indirect.child = { parent: indirect }

    assert.deepStrictEqual(computeTags(safeConfig, indirect, responseOpts), {
      'aws.response.body.name': 'indirect',
      'aws.response.body.child.parent': 'truncated',
      '_dd.payload_tags_incomplete': true,
    })

    const array = /** @type {unknown[]} */ (['x'])
    array.push(array)

    assert.deepStrictEqual(computeTags(safeConfig, array, responseOpts), {
      'aws.response.body.0': 'x',
      'aws.response.body.1': 'truncated',
      '_dd.payload_tags_incomplete': true,
    })
  })

  it('should bound class instance traversal and replace cycles with "truncated"', () => {
    class Instance {}
    const instance = Object.assign(new Instance(), {
      name: 'instance',
      self: /** @type {unknown} */ (null),
    })
    instance.self = instance

    assert.deepStrictEqual(computeTags(safeConfig, instance, responseOpts), {
      'aws.response.body.name': 'instance',
      'aws.response.body.self': 'truncated',
      '_dd.payload_tags_incomplete': true,
    })
  })

  it('should redact aliased objects per path instead of deduplicating them', () => {
    const shared = { secret: 's3cret', plain: 'ok' }
    const input = { a: shared, b: shared }
    const config = { expand: [], request: [], response: ['$.a.secret'] }

    const tags = computeTags(config, input, responseOpts)

    assert.strictEqual(tags['aws.response.body.a.secret'], 'redacted')
    assert.strictEqual(tags['aws.response.body.b.secret'], 's3cret')
  })

  it('should apply recursive descent rules to cyclic payloads', () => {
    const input = { secret: 's3cret' }
    input.self = input
    const config = { expand: [], request: [], response: ['$..secret'] }

    const tags = computeTags(config, input, responseOpts)

    assert.strictEqual(tags['aws.response.body.secret'], 'redacted')
    assert.strictEqual(tags['aws.response.body.self'], 'truncated')
  })

  it('should suppress payload tags when capture is incomplete and rules are data-dependent', () => {
    const input = { Body: makeReadable(), token: 's3cret' }
    const config = { expand: [], request: [], response: ['$..[?(@.token)]'] }

    assert.deepStrictEqual(computeTags(config, input, responseOpts), {})
  })

  it('should retain partial payload tags with the incomplete flag when rules are structural', () => {
    const input = { Body: makeReadable(), ETag: '"etag"', token: 's3cret' }
    const config = { expand: [], request: [], response: ['$.token'] }

    const tags = computeTags(config, input, responseOpts)

    assert.strictEqual(tags['aws.response.body.token'], 'redacted')
    assert.strictEqual(tags['aws.response.body.ETag'], '"etag"')
    assert.strictEqual(tags['aws.response.body.Body'], 'truncated')
    assert.strictEqual(tags['_dd.payload_tags_incomplete'], true)
  })

  it('should bound traversal depth independently of the output max depth', () => {
    let deep = /** @type {unknown} */ ({ leaf: true })
    for (let i = 0; i < 150; i++) {
      deep = { nested: deep }
    }

    const tags = computeTags(safeConfig, deep, { maxDepth: 500, prefix: PAYLOAD_TAG_RESPONSE_PREFIX })

    assert.strictEqual(tags['_dd.payload_tags_incomplete'], true)
    assert.ok(Object.keys(tags).every(key => key.split('.').length <= 105))
    assert.ok(Object.values(tags).includes('truncated'))
  })

  it('should keep partial tags and flag incompleteness when the work budget is exhausted', () => {
    const input = {
      values: Object.fromEntries([...Array(20000).keys()].map(i => [`k${i}`, i])),
    }

    const tags = computeTags(safeConfig, input, responseOpts)

    assert.strictEqual(tags['_dd.payload_tags_incomplete'], true)
    assert.strictEqual(tags['aws.response.body.values.k0'], '0')
    assert.ok(!('aws.response.body.values.k15000' in tags))
  })

  it('should truncate oversized arrays instead of walking every index', () => {
    const array = new Array(50000)
    array[0] = 'head'
    array[49999] = 'tail'

    const tags = computeTags(safeConfig, { list: array }, responseOpts)

    assert.strictEqual(tags['aws.response.body.list'], 'truncated')
    assert.strictEqual(tags['_dd.payload_tags_incomplete'], true)
  })

  it('should bound the expansion of very large JSON strings', () => {
    const huge = `{ "a": "${'x'.repeat(1000001)}" }`
    const config = { expand: ['$.body'], request: [], response: [] }

    const tags = computeTags(config, { body: huge }, { maxDepth: 10, prefix: 'foo' })

    assert.strictEqual(tags['foo.body'], 'truncated')
    assert.strictEqual(tags['_dd.payload_tags_incomplete'], true)
  })

  it('should suppress payload tags when expansion truncation meets data-dependent redaction rules', () => {
    const huge = `{ "a": "${'x'.repeat(1000001)}" }`
    const config = { expand: ['$.body'], request: [], response: ['$..[?(@.token)]'] }

    assert.deepStrictEqual(
      computeTags(config, { body: huge, token: 's3cret' }, { maxDepth: 10, prefix: 'foo' }),
      {}
    )
  })

  it('should bound the expansion of deeply nested JSON strings', () => {
    let json = '"leaf"'
    for (let i = 0; i < 500; i++) {
      json = `{"a":${json}}`
    }
    const config = { expand: ['$.body'], request: [], response: [] }

    const tags = computeTags(config, { body: json }, { maxDepth: 500, prefix: 'foo' })

    assert.strictEqual(tags['_dd.payload_tags_incomplete'], true)
    assert.ok(Object.keys(tags).every(key => key.split('.').length <= 105))
  })

  it('should not mutate the input payload', () => {
    const input = deepFreeze({ a: { b: 'keep' }, list: ['x'] })
    const config = { expand: [], request: [], response: ['$.a.b'] }

    const tags = computeTags(config, input, responseOpts)

    assert.strictEqual(tags['aws.response.body.a.b'], 'redacted')
    assert.strictEqual(tags['aws.response.body.list.0'], 'x')
    assert.strictEqual(input.a.b, 'keep')
  })

  it('should not pollute prototypes when copying "__proto__" keys', () => {
    const input = JSON.parse('{ "list": [ { "__proto__": { "polluted": true } }, "tail" ] }')

    const tags = computeTags(safeConfig, input, responseOpts)

    assert.ok(!('polluted' in Object.prototype))
    assert.ok(!('polluted' in Array.prototype))
    assert.strictEqual(tags['aws.response.body.list.0.__proto__.polluted'], 'true')
    assert.strictEqual(tags['aws.response.body.list.1'], 'tail')
  })

  it('should omit payload tags when capture fails unexpectedly', () => {
    const input = {}
    Object.defineProperty(input, 'boom', {
      get () {
        throw new Error('boom')
      },
      enumerable: true,
    })
    input.safe = 'ok'

    assert.deepStrictEqual(computeTags(safeConfig, input, responseOpts), {})
  })
})
