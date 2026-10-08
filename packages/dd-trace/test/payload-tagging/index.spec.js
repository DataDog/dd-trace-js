'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { Readable } = require('node:stream')
const nodeVm = require('node:vm')
const sinon = require('sinon')
const {
  PAYLOAD_TAG_REQUEST_PREFIX,
  PAYLOAD_TAG_RESPONSE_PREFIX,
} = require('../../src/constants')
const log = require('../../src/log')
const { tagsFromObject } = require('../../src/payload-tagging/tagging')
const { computeTags } = require('../../src/payload-tagging')
const { createSafeSnapshot } = require('../../src/payload-tagging/snapshot')
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

  describe('payload-controlled exceptions', () => {
    /** @type {Array<[string, (inspect: () => void) => unknown]>} */
    const cases = [
      ['ordinary Error', () => new Error('payload-secret')],
      ['string', () => 'payload-secret'],
      ['null', () => null],
      ['undefined', () => undefined],
      ['symbol', () => Symbol('payload-secret')],
      ['hostile Error', inspect => {
        const error = new Error('payload-secret')
        // Define stack first, before V8 can consult the hostile name getter.
        for (const key of ['stack', 'message', 'name', Symbol.toPrimitive]) {
          Object.defineProperty(error, key, {
            get () {
              inspect()
              throw error
            },
          })
        }
        return error
      }],
      ['hostile Proxy', inspect => new Proxy({}, {
        get () { inspect(); throw new Error('unexpected inspection') },
        getPrototypeOf () { inspect(); throw new Error('unexpected reflection') },
      })],
    ]

    for (const [name, makeError] of cases) {
      it(`omits tags without inspecting a thrown ${name}`, () => {
        const inspect = sinon.spy()
        const error = makeError(inspect)
        const input = Object.defineProperty({ safe: 'ok' }, 'getReader', {
          get () { throw error },
        })
        const diagnostic = sinon.stub(log, 'error')
        try {
          assert.deepStrictEqual(computeTags(safeConfig, input, responseOpts), {})
          assert.strictEqual(inspect.callCount, 0)
          assert.strictEqual(diagnostic.callCount, 1)
          assert.deepStrictEqual(diagnostic.firstCall.args, [
            'Error generating payload tags; omitting payload tags for this operation',
          ])
        } finally {
          diagnostic.restore()
        }
      })
    }
  })

  describe('binary capture safety', () => {
    const requestOpts = { maxDepth: 10, prefix: PAYLOAD_TAG_REQUEST_PREFIX }

    it('should redact a Buffer element without mutating the original bytes', () => {
      const body = Buffer.from('abc')
      const config = { expand: [], request: ['$.Body[1]'], response: [] }

      const tags = computeTags(config, { Body: body }, requestOpts)

      assert.strictEqual(body.toString('hex'), '616263')
      // The redacted byte belongs to the snapshot copy, not to the caller.
      assert.strictEqual(tags['aws.request.body.Body'], 'a\u0000c')
    })

    it('should redact a typed-array element without mutating the original bytes', () => {
      const body = new Uint8Array([104, 105])
      const config = { expand: [], request: ['$.Body[1]'], response: [] }

      const tags = computeTags(config, { Body: body }, requestOpts)

      assert.deepStrictEqual(Array.from(body), [104, 105])
      // Per-index tag format is preserved and the redacted copy element no
      // longer exposes the original value.
      assert.strictEqual(tags['aws.request.body.Body.0'], '104')
      assert.notStrictEqual(tags['aws.request.body.Body.1'], '105')
    })

    it('should copy aliased binary values independently per occurrence', () => {
      const shared = Buffer.from('secret')
      const config = { expand: [], request: ['$.a[0]'], response: [] }

      const tags = computeTags(config, { a: shared, b: shared }, requestOpts)

      assert.strictEqual(tags['aws.request.body.a'], '\u0000ecret')
      assert.strictEqual(tags['aws.request.body.b'], 'secret')
      assert.strictEqual(shared.toString(), 'secret')
    })

    it('should keep the Buffer string tag format below the binary budget', () => {
      const tags = computeTags(safeConfig, { Body: Buffer.from('abc') }, responseOpts)

      assert.strictEqual(tags['aws.response.body.Body'], 'abc')
      assert.strictEqual(tags['_dd.payload_tags_incomplete'], undefined)
    })

    it('should keep the typed-array per-index tag format below the binary budget', () => {
      const tags = computeTags(safeConfig, { Body: new Uint8Array([104, 105]) }, responseOpts)

      assert.deepStrictEqual(tags, {
        'aws.response.body.Body.0': '104',
        'aws.response.body.Body.1': '105',
      })
    })

    it('should accept a binary value at the last byte of the copy budget', () => {
      const body = Buffer.alloc(1_000_000, 120)
      const tags = computeTags(safeConfig, { Body: body }, responseOpts)

      assert.strictEqual(tags['aws.response.body.Body'], 'x'.repeat(5000))
      assert.strictEqual(tags['_dd.payload_tags_incomplete'], undefined)
    })

    it('should reject a binary value at the first byte beyond the copy budget', () => {
      const body = Buffer.alloc(1_000_001, 120)
      const tags = computeTags(safeConfig, { Body: body }, responseOpts)

      assert.strictEqual(tags['aws.response.body.Body'], 'truncated')
      assert.strictEqual(tags['_dd.payload_tags_incomplete'], true)
    })

    it('should exhaust the aggregate binary budget across multiple values', () => {
      const first = Buffer.alloc(600_000, 97)
      const second = Buffer.alloc(600_000, 98)

      const tags = computeTags(safeConfig, { a: first, b: second }, responseOpts)

      assert.strictEqual(tags['aws.response.body.a'], 'a'.repeat(5000))
      assert.strictEqual(tags['aws.response.body.b'], 'truncated')
      assert.strictEqual(tags['_dd.payload_tags_incomplete'], true)
      // The oversized second value must not have consumed the first one.
      assert.strictEqual(first[0], 97)
      assert.strictEqual(second[0], 98)
    })

    it('should copy only the visible range of a view with a nonzero offset', () => {
      const backing = new Uint8Array([1, 2, 3, 4, 5])
      const view = backing.subarray(2)
      const config = { expand: [], request: ['$.Body[0]'], response: [] }

      const tags = computeTags(config, { Body: view }, requestOpts)

      // Per-index tags cover the visible range only, starting at zero.
      assert.deepStrictEqual(tags, {
        'aws.request.body.Body.0': '0',
        'aws.request.body.Body.1': '4',
        'aws.request.body.Body.2': '5',
      })
      assert.deepStrictEqual(Array.from(backing), [1, 2, 3, 4, 5])
    })

    for (const byteLength of [0, 2]) {
      it(`should isolate a DataView with a nonzero offset and ${byteLength} visible bytes`, () => {
        const backing = new Uint8Array([1, 2, 3, 4, 5])
        const view = new DataView(backing.buffer, 2, byteLength)

        const snapshot = createSafeSnapshot({ Body: view })
        const copy = /** @type {{ Body: DataView }} */ (snapshot.value).Body

        assert.strictEqual(snapshot.incomplete, false)
        assert.ok(copy instanceof DataView)
        assert.notStrictEqual(copy.buffer, backing.buffer)
        assert.strictEqual(copy.byteOffset, 0)
        assert.strictEqual(copy.byteLength, byteLength)
        assert.strictEqual(copy.buffer.byteLength, byteLength)
        if (byteLength > 0) {
          assert.strictEqual(copy.getUint8(0), 3)
          assert.strictEqual(copy.getUint8(1), 4)
          copy.setUint8(0, 0)
        }
        assert.deepStrictEqual(Array.from(backing), [1, 2, 3, 4, 5])
      })
    }

    describe('empty views backed by nonempty storage', () => {
      /**
       * Install a payload-controlled `constructor` hook on the backing storage
       * and return counters for every way capture could consult it. The
       * `species-call` mode also mutates a nonempty backing byte if the species
       * function runs, so silent invocation is observable.
       *
       * @param {ArrayBuffer | SharedArrayBuffer} backing
       * @param {'getter' | 'species-getter' | 'species-call'} mode
       * @returns {{ getterReads: number, speciesGets: number, speciesCalls: number }}
       */
      function hookBackingConstructor (backing, mode) {
        const probe = { getterReads: 0, speciesGets: 0, speciesCalls: 0 }
        if (mode === 'getter') {
          Object.defineProperty(backing, 'constructor', {
            get () {
              probe.getterReads++
              throw new Error('constructor getter')
            },
          })
          return probe
        }
        const speciesTarget = {}
        if (mode === 'species-getter') {
          Object.defineProperty(speciesTarget, Symbol.species, {
            get () {
              probe.speciesGets++
              throw new Error('species getter')
            },
          })
        } else {
          speciesTarget[Symbol.species] = function (size) {
            probe.speciesCalls++
            new Uint8Array(/** @type {ArrayBuffer} */ (backing))[1] = 0
            return new ArrayBuffer(size)
          }
        }
        Object.defineProperty(backing, 'constructor', { value: speciesTarget })
        return probe
      }

      for (const name of ['Uint8Array', 'Buffer']) {
        for (const mode of ['getter', 'species-getter', 'species-call']) {
          it(`should capture an empty ${name} view without consulting its backing constructor (${mode})`, () => {
            const backing = new ArrayBuffer(3)
            new Uint8Array(backing).set([97, 98, 99])
            /** @type {Uint8Array | Buffer} */
            const body = name === 'Buffer'
              ? Buffer.from(backing, 2, 0)
              : new Uint8Array(backing, 1, 0)
            const probe = hookBackingConstructor(
              backing,
              /** @type {'getter' | 'species-getter' | 'species-call'} */ (mode)
            )

            const snapshot = createSafeSnapshot({ Body: body, Ok: 'sib' })

            assert.strictEqual(snapshot.incomplete, false)
            assert.strictEqual(probe.getterReads, 0)
            assert.strictEqual(probe.speciesGets, 0)
            assert.strictEqual(probe.speciesCalls, 0)
            assert.deepStrictEqual(Array.from(new Uint8Array(backing)), [97, 98, 99])
            const copy = /** @type {{ Body: Uint8Array | Buffer, Ok: string }} */ (snapshot.value).Body
            if (name === 'Buffer') {
              assert.ok(Buffer.isBuffer(copy))
            } else {
              assert.strictEqual(copy.constructor, Uint8Array)
            }
            assert.strictEqual(copy.byteLength, 0)
            assert.notStrictEqual(copy.buffer, backing)
            // Capture of the hooked value must not block its safe sibling.
            assert.strictEqual(/** @type {{ Ok: string }} */ (snapshot.value).Ok, 'sib')
          })
        }
      }

      it('should capture an empty DataView control without consulting its backing constructor', () => {
        const backing = new ArrayBuffer(3)
        new Uint8Array(backing).set([97, 98, 99])
        const body = new DataView(backing, 2, 0)
        const probe = hookBackingConstructor(backing, 'species-call')

        const snapshot = createSafeSnapshot({ Body: body, Ok: 'sib' })

        assert.strictEqual(snapshot.incomplete, false)
        assert.strictEqual(probe.speciesCalls, 0)
        assert.deepStrictEqual(Array.from(new Uint8Array(backing)), [97, 98, 99])
        const copy = /** @type {{ Body: DataView }} */ (snapshot.value).Body
        assert.ok(copy instanceof DataView)
        assert.strictEqual(copy.byteLength, 0)
        assert.notStrictEqual(copy.buffer, backing)
        assert.strictEqual(/** @type {{ Ok: string }} */ (snapshot.value).Ok, 'sib')
      })

      it('should capture a same-realm empty shared-backed typed array without consulting its constructor', () => {
        const backing = new SharedArrayBuffer(3)
        new Uint8Array(backing).set([97, 98, 99])
        const body = new Uint8Array(backing, 1, 0)
        const probe = hookBackingConstructor(backing, 'species-call')

        const snapshot = createSafeSnapshot({ Body: body })

        assert.strictEqual(snapshot.incomplete, false)
        assert.strictEqual(probe.speciesCalls, 0)
        assert.deepStrictEqual(Array.from(new Uint8Array(backing)), [97, 98, 99])
        const copy = /** @type {{ Body: Uint8Array }} */ (snapshot.value).Body
        assert.strictEqual(copy.constructor, Uint8Array)
        assert.strictEqual(copy.byteLength, 0)
        assert.notStrictEqual(copy.buffer, backing)
      })

      it('should capture a cross-realm empty shared-backed typed array without consulting its constructor', () => {
        // The backing storage and the view both come from a foreign realm, so
        // this covers removal of the realm-sensitive detachment branch.
        const { backing, ForeignUint8Array } = nodeVm.runInNewContext(`
          const backing = new SharedArrayBuffer(3)
          new Uint8Array(backing).set([97, 98, 99])
          ;({ backing, ForeignUint8Array: Uint8Array })
        `)
        const body = new ForeignUint8Array(backing, 2, 0)
        const probe = hookBackingConstructor(backing, 'species-call')

        const snapshot = createSafeSnapshot({ Body: body })

        assert.strictEqual(snapshot.incomplete, false)
        assert.strictEqual(probe.speciesCalls, 0)
        assert.deepStrictEqual(Array.from(new Uint8Array(backing)), [97, 98, 99])
        const copy = /** @type {{ Body: Uint8Array }} */ (snapshot.value).Body
        assert.strictEqual(copy.constructor, Uint8Array)
        assert.strictEqual(copy.byteLength, 0)
        assert.notStrictEqual(copy.buffer, backing)
      })
    })

    it('should omit payload tags without throwing when a typed-array buffer is detached', () => {
      const body = new Uint8Array([1, 2])
      structuredClone(body.buffer, { transfer: [body.buffer] })

      assert.deepStrictEqual(computeTags(safeConfig, { Body: body, Ok: true }, responseOpts), {})
    })

    for (const visibleLength of [0, 3]) {
      it(`should omit payload tags when a detached DataView with ${visibleLength} visible bytes is captured`, () => {
        const backing = new ArrayBuffer(3)
        const body = new DataView(backing, 0, visibleLength)
        structuredClone(backing, { transfer: [backing] })

        assert.throws(() => createSafeSnapshot({ Body: body, Ok: true }), TypeError)

        const config = { expand: [], request: [], response: [] }
        // No redaction or expansion rules: data-dependent rules would suppress
        // the broken partial capture and conceal the defect.
        assert.deepStrictEqual(
          computeTags(config, { Body: body, Ok: true }, { prefix: PAYLOAD_TAG_RESPONSE_PREFIX, maxDepth: 10 }),
          {}
        )
        assert.deepStrictEqual(
          computeTags(config, { Body: body, Ok: true }, { prefix: PAYLOAD_TAG_REQUEST_PREFIX, maxDepth: 10 }),
          {}
        )
      })
    }

    for (const name of ['typed-array', 'Buffer']) {
      it(`should omit payload tags without throwing when an originally empty ${name} view is detached`, () => {
        const backing = new ArrayBuffer(3)
        /** @type {Uint8Array | Buffer} */
        const body = name === 'Buffer' ? Buffer.from(backing, 1, 0) : new Uint8Array(backing, 1, 0)
        structuredClone(backing, { transfer: [backing] })

        assert.throws(() => createSafeSnapshot({ Body: body }), TypeError)

        assert.deepStrictEqual(computeTags(safeConfig, { Body: body, Ok: true }, responseOpts), {})
      })
    }

    it('should keep partial tags and flag incompleteness when a binary value exceeds the budget', () => {
      const body = Buffer.alloc(1_000_001, 120)
      const config = { expand: [], request: ['$.Ok'], response: [] }

      const tags = computeTags(config, { Body: body, Ok: true }, requestOpts)

      assert.strictEqual(tags['aws.request.body.Ok'], 'redacted')
      assert.strictEqual(tags['aws.request.body.Body'], 'truncated')
      assert.strictEqual(tags['_dd.payload_tags_incomplete'], true)
    })

    it('should not mutate caller bytes when an own slice override shares storage', () => {
      const body = new Uint8Array([97, 98, 99])
      let calls = 0
      Object.defineProperty(body, 'slice', {
        value () {
          calls++
          return this.subarray()
        },
      })
      const config = { expand: [], request: ['$.Body[1]'], response: [] }

      const tags = computeTags(config, { Body: body }, requestOpts)

      assert.strictEqual(calls, 0)
      assert.deepStrictEqual(Array.from(body), [97, 98, 99])
      assert.strictEqual(tags['aws.request.body.Body.0'], '97')
      assert.notStrictEqual(tags['aws.request.body.Body.1'], '98')
    })

    it('should ignore a subclass slice override and preserve the native element type', () => {
      class View extends Uint8Array {}
      const body = new View([97, 98, 99])
      let calls = 0
      Object.defineProperty(body, 'slice', {
        value () {
          calls++
          return this
        },
      })
      const config = { expand: [], request: ['$.Body[1]'], response: [] }

      const snapshot = createSafeSnapshot({ Body: body })

      assert.strictEqual(calls, 0)
      assert.strictEqual(snapshot.incomplete, false)
      const copy = /** @type {{ Body: Uint8Array }} */ (snapshot.value).Body
      // The copy must be the native kind, not the payload-defined subclass.
      assert.strictEqual(copy.constructor, Uint8Array)
      assert.deepStrictEqual(Array.from(copy), [97, 98, 99])
      assert.notStrictEqual(copy.buffer, body.buffer)

      const tags = computeTags(config, { Body: body }, requestOpts)

      assert.strictEqual(calls, 0)
      assert.deepStrictEqual(Array.from(body), [97, 98, 99])
      assert.strictEqual(tags['aws.request.body.Body.0'], '97')
      assert.notStrictEqual(tags['aws.request.body.Body.1'], '98')
    })

    it('should ignore custom species returning caller-owned storage', () => {
      const body = new Uint8Array([97, 98, 99])
      let speciesCalls = 0
      Object.defineProperty(body, 'constructor', {
        value: {
          [Symbol.species]: function () {
            speciesCalls++
            return new Uint8Array(body.buffer)
          },
        },
      })
      const config = { expand: [], request: ['$.Body[1]'], response: [] }

      const tags = computeTags(config, { Body: body }, requestOpts)

      assert.strictEqual(speciesCalls, 0)
      assert.deepStrictEqual(Array.from(body), [97, 98, 99])
      assert.strictEqual(tags['aws.request.body.Body.0'], '97')
      assert.notStrictEqual(tags['aws.request.body.Body.1'], '98')
    })

    it('should copy without invoking payload-defined hooks whose getters throw', () => {
      const body = new Uint8Array([97, 98, 99])
      const hooks = ['slice', 'constructor']
      for (const hook of hooks) {
        Object.defineProperty(body, hook, {
          get () {
            throw new Error(hook)
          },
        })
      }
      const config = { expand: [], request: ['$.Body[1]'], response: [] }

      const tags = computeTags(config, { Body: body }, requestOpts)

      assert.deepStrictEqual(Array.from(body), [97, 98, 99])
      assert.strictEqual(tags['aws.request.body.Body.0'], '97')
      assert.notStrictEqual(tags['aws.request.body.Body.1'], '98')
    })

    it('should copy using intrinsic metadata when payload metadata getters throw', () => {
      const body = new Uint8Array([97, 98, 99])
      for (const key of ['byteLength', 'byteOffset', 'buffer']) {
        Object.defineProperty(body, key, {
          get () {
            throw new Error(key)
          },
        })
      }

      const snapshot = createSafeSnapshot({ Body: body })

      assert.strictEqual(snapshot.incomplete, false)
      const copy = /** @type {{ Body: Uint8Array }} */ (snapshot.value).Body
      assert.deepStrictEqual(Array.from(copy), [97, 98, 99])
    })

    it('should copy a DataView using intrinsic metadata when its own metadata getters throw', () => {
      const backing = new Uint8Array([1, 2, 3, 4])
      const view = new DataView(backing.buffer, 1, 2)
      for (const key of ['byteLength', 'byteOffset', 'buffer']) {
        Object.defineProperty(view, key, {
          get () {
            throw new Error(key)
          },
        })
      }

      const snapshot = createSafeSnapshot({ Body: view })

      assert.strictEqual(snapshot.incomplete, false)
      const copy = /** @type {{ Body: DataView }} */ (snapshot.value).Body
      assert.strictEqual(copy.byteLength, 2)
      assert.strictEqual(copy.getUint8(0), 2)
      assert.strictEqual(copy.getUint8(1), 3)
      assert.deepStrictEqual(Array.from(backing), [1, 2, 3, 4])
    })

    it('should detect the native kind without invoking a spoofed toStringTag', () => {
      const body = new Uint8Array([104, 105])
      let reads = 0
      Object.defineProperty(body, Symbol.toStringTag, {
        get () {
          reads++
          throw new Error('toStringTag')
        },
      })

      const snapshot = createSafeSnapshot({ Body: body })

      assert.strictEqual(reads, 0)
      assert.strictEqual(snapshot.incomplete, false)
      assert.strictEqual(/** @type {{ Body: Uint8Array }} */ (snapshot.value).Body.constructor, Uint8Array)
    })

    it('should capture a clean copy when an overridden slice returns an oversized array', () => {
      // The overridden slice previously let a three-byte value smuggle a
      // 1,000,001-byte array past the binary copy budget.
      const oversized = new Uint8Array(1_000_001)
      const body = new Uint8Array([97, 98, 99])
      Object.defineProperty(body, 'slice', { value () { return oversized } })

      const snapshot = createSafeSnapshot({ Body: body })

      assert.strictEqual(snapshot.incomplete, false)
      const copy = /** @type {{ Body: Uint8Array }} */ (snapshot.value).Body
      assert.strictEqual(copy.byteLength, 3)
      assert.deepStrictEqual(Array.from(copy), [97, 98, 99])
      assert.notStrictEqual(copy, oversized)
      assert.strictEqual(oversized.byteLength, 1_000_001)
    })

    it('should reject an oversized typed array that spoofs byteLength', () => {
      const body = new Uint8Array(1_000_001)
      Object.defineProperty(body, 'byteLength', { value: 0 })

      const snapshot = createSafeSnapshot({ Body: body })

      assert.strictEqual(snapshot.incomplete, true)
      assert.strictEqual(/** @type {{ Body: unknown }} */ (snapshot.value).Body, 'truncated')
    })

    it('should reject an oversized Buffer that spoofs byteLength', () => {
      const body = Buffer.alloc(1_000_001)
      Object.defineProperty(body, 'byteLength', { value: 0 })

      const snapshot = createSafeSnapshot({ Body: body })

      assert.strictEqual(snapshot.incomplete, true)
      assert.strictEqual(/** @type {{ Body: unknown }} */ (snapshot.value).Body, 'truncated')
    })

    it('should preserve the native element type of every declared typed array', () => {
      const kinds = /** @type {typeof Uint8Array[]} */ (/** @type {unknown} */ ([
        Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
        Int32Array, Uint32Array, Float32Array, Float64Array,
        BigInt64Array, BigUint64Array,
      ]))
      const isBigInt = kind => kind === BigInt64Array || kind === BigUint64Array

      for (const Kind of kinds) {
        const body = new Kind(/** @type {number[]} */ (/** @type {unknown} */ (
          isBigInt(Kind) ? [1n, 2n] : [1, 2]
        )))

        const snapshot = createSafeSnapshot({ Body: body })

        assert.strictEqual(snapshot.incomplete, false, Kind.name)
        const copy = /** @type {{ Body: Uint8Array }} */ (snapshot.value).Body
        assert.strictEqual(copy.constructor, Kind, Kind.name)
        assert.deepStrictEqual(Array.from(copy), Array.from(body), Kind.name)
        assert.notStrictEqual(copy.buffer, body.buffer, Kind.name)
      }
    })

    it('should copy BigInt arrays with raw-byte and type preservation', () => {
      const body = new BigUint64Array([0n, 0xffff_ffff_ffff_ffffn])

      const snapshot = createSafeSnapshot({ Body: body })

      assert.strictEqual(snapshot.incomplete, false)
      const copy = /** @type {{ Body: BigUint64Array }} */ (snapshot.value).Body
      assert.strictEqual(copy.constructor, BigUint64Array)
      assert.deepStrictEqual(Array.from(copy), [0n, 0xffff_ffff_ffff_ffffn])
      assert.notStrictEqual(copy.buffer, body.buffer)
    })

    it('should admit a small visible range backed by an oversized buffer', () => {
      const backing = new Uint8Array(2_000_000)
      const view = backing.subarray(0, 3)

      const snapshot = createSafeSnapshot({ Body: view })

      assert.strictEqual(snapshot.incomplete, false)
      const copy = /** @type {{ Body: Uint8Array }} */ (snapshot.value).Body
      assert.strictEqual(copy.byteLength, 3)
      assert.notStrictEqual(copy.buffer, backing.buffer)
      assert.strictEqual(backing.byteLength, 2_000_000)
    })

    it('should copy aliased typed arrays independently per occurrence', () => {
      const shared = new Uint8Array([115, 101, 99, 114, 101, 116])
      const config = { expand: [], request: ['$.a[0]'], response: [] }

      const tags = computeTags(config, { a: shared, b: shared }, requestOpts)

      assert.strictEqual(tags['aws.request.body.a.0'], '0')
      assert.strictEqual(tags['aws.request.body.b.0'], '115')
      assert.strictEqual(shared[0], 115)
    })

    it('should account for the aggregate budget across mixed binary kinds', () => {
      const first = Buffer.alloc(600_000, 97)
      const second = new Uint8Array(600_000).fill(98)

      const tags = computeTags(safeConfig, { a: first, b: second }, responseOpts)

      assert.strictEqual(tags['aws.response.body.a'], 'a'.repeat(5000))
      assert.strictEqual(tags['aws.response.body.b'], 'truncated')
      assert.strictEqual(tags['_dd.payload_tags_incomplete'], true)
      assert.strictEqual(first[0], 97)
      assert.strictEqual(second[0], 98)
    })

    // Skipped on runtimes without the optional numeric format: there is then
    // no unsupported kind left to exercise.
    it('should truncate an unsupported typed-array kind in an isolated process', async function () {
      if (typeof (/** @type {Record<string, unknown>} */ (globalThis)).Float16Array !== 'function') {
        this.skip()
      }

      // Masking the optional global before loading the module leaves a genuine
      // Float16Array view that the snapshot module must treat as unsupported.
      const script = `
        const Float16Array = globalThis.Float16Array
        globalThis.Float16Array = undefined
        const { createSafeSnapshot } = require(${JSON.stringify(
          require.resolve('../../src/payload-tagging/snapshot')
        )})
        const view = new Float16Array([1.5, 2.5])
        const snapshot = createSafeSnapshot({ Body: view, Ok: true })
        console.log(JSON.stringify({
          incomplete: snapshot.incomplete,
          body: snapshot.value.Body,
          ok: snapshot.value.Ok,
        }))
      `
      const stdout = await new Promise((resolve, reject) => {
        execFile(process.execPath, ['-e', script], (err, out) => (err ? reject(err) : resolve(out)))
      })

      assert.deepStrictEqual(JSON.parse(stdout), {
        incomplete: true,
        body: 'truncated',
        ok: true,
      })
    })
  })

  describe('entry and width accounting', () => {
    /**
     * @param {number} count
     * @param {number | null} throwAt index whose getter throws, or null
     * @returns {{ container: object, reads: () => number }}
     */
    function getterProbe (count, throwAt) {
      let reads = 0
      const container = {}
      for (let i = 0; i < count; i++) {
        Object.defineProperty(container, `k${i}`, {
          enumerable: true,
          get () {
            reads++
            if (i === throwAt) throw new Error('boom')
            return i
          },
        })
      }
      return { container, reads: () => reads }
    }

    /**
     * @param {{ value: unknown, incomplete: boolean }} snapshot
     * @returns {Record<string, unknown>}
     */
    function captured (snapshot) {
      return /** @type {Record<string, unknown>} */ (snapshot.value)
    }

    it('should keep a snapshot complete at the entry budget boundary', () => {
      // Root plus 9,999 admitted children is exactly the 10,000-entry budget.
      const input = Object.fromEntries([...Array(9_999).keys()].map(i => [`k${i}`, i]))

      const snapshot = createSafeSnapshot(input)

      assert.strictEqual(snapshot.incomplete, false)
      assert.strictEqual(Object.keys(captured(snapshot)).length, 9_999)
    })

    it('should omit overflow properties instead of materializing placeholders past the budget', () => {
      const input = Object.fromEntries([...Array(10_000).keys()].map(i => [`k${i}`, i]))

      const snapshot = createSafeSnapshot(input)

      assert.strictEqual(snapshot.incomplete, true)
      assert.strictEqual(Object.keys(captured(snapshot)).length, 9_999)
      assert.strictEqual(captured(snapshot).k0, 0)
      assert.ok(!('k9999' in captured(snapshot)))
    })

    it('should bound getter reads on wide objects and never read past the budget', () => {
      // A throwing getter past the retained prefix must never be read.
      const { container, reads } = getterProbe(20_000, 15_000)

      const snapshot = createSafeSnapshot(container)

      assert.strictEqual(snapshot.incomplete, true)
      assert.ok(reads() <= 9_999)
      assert.ok(Object.keys(captured(snapshot)).length < 20_000)
    })

    it('should not read pending sibling work once the entry budget is exhausted', () => {
      // The first container alone exhausts the budget, so the second
      // container's getters must never run.
      const first = getterProbe(10_000, null)
      const second = getterProbe(10_000, null)
      const input = { a: first.container, b: second.container }

      const snapshot = createSafeSnapshot(input)

      assert.strictEqual(snapshot.incomplete, true)
      assert.ok(Object.keys(/** @type {Record<string, unknown>} */ (captured(snapshot).a)).length > 0)
      assert.ok(!('b' in captured(snapshot)))
      assert.strictEqual(second.reads(), 0)
      assert.ok(first.reads() <= 9_999)
    })

    it('should preserve original key order and array indexes in partial captures', () => {
      const input = { z: 1, a: 2, list: ['x', 'y'] }

      const snapshot = createSafeSnapshot(input)

      assert.deepStrictEqual(Object.keys(captured(snapshot)), ['z', 'a', 'list'])
      assert.deepStrictEqual(captured(snapshot).list, ['x', 'y'])
    })
  })

  describe('suppression diagnostics', () => {
    const snapshotMessage =
      'Omitting payload tags: the snapshot was truncated and the rules are data-dependent'
    const expansionMessage =
      'Omitting payload tags: expansion was truncated and the redaction rules are data-dependent'

    afterEach(() => {
      sinon.restore()
    })

    it('should emit a payload-safe debug reason for snapshot-truncation suppression', () => {
      const debug = sinon.stub(log, 'debug')
      const input = { Body: makeReadable(), token: 's3cret' }
      const config = { expand: [], request: [], response: ['$..[?(@.token)]'] }

      assert.deepStrictEqual(computeTags(config, input, responseOpts), {})

      assert.ok(debug.getCalls().some(call => call.args[0] === snapshotMessage))
      // The diagnostic must never carry payload values or rule text.
      for (const call of debug.getCalls()) {
        const text = call.args.join(' ')
        assert.ok(!text.includes('s3cret'))
        assert.ok(!text.includes('token'))
      }
    })

    it('should emit a payload-safe debug reason for expansion-truncation suppression', () => {
      const debug = sinon.stub(log, 'debug')
      const huge = `{ "a": "${'x'.repeat(1000001)}" }`
      const config = { expand: ['$.body'], request: [], response: ['$..[?(@.token)]'] }

      assert.deepStrictEqual(
        computeTags(config, { body: huge, token: 's3cret' }, { maxDepth: 10, prefix: 'foo' }),
        {}
      )

      assert.ok(debug.getCalls().some(call => call.args[0] === expansionMessage))
      assert.ok(!debug.getCalls().some(call => call.args[0] === snapshotMessage))
    })

    it('should not emit a suppression diagnostic for successful captures', () => {
      const debug = sinon.stub(log, 'debug')

      computeTags(safeConfig, { ETag: '"etag"' }, responseOpts)

      assert.strictEqual(debug.getCalls().length, 0)
    })
  })
})
