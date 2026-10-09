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
const { createSafeSnapshot, createSnapshotBudget } = require('../../src/payload-tagging/snapshot')
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

  it('should redact and expand array elements at index 0', () => {
    const config = {
      request: ['$.secrets[*]'],
      response: [],
      expand: ['$.messages[*]'],
    }
    const input = {
      secrets: ['s0', 's1'],
      messages: ['{ "id": 0 }', '{ "id": 1 }'],
    }
    const prefix = PAYLOAD_TAG_REQUEST_PREFIX
    const tags = computeTags(config, input, { maxDepth: 10, prefix })
    assert.deepStrictEqual(tags, {
      [`${prefix}.secrets.0`]: 'redacted',
      [`${prefix}.secrets.1`]: 'redacted',
      [`${prefix}.messages.0.id`]: '0',
      [`${prefix}.messages.1.id`]: '1',
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

  describe('SLES-3026 regressions', () => {
    for (const prefix of [PAYLOAD_TAG_REQUEST_PREFIX, PAYLOAD_TAG_RESPONSE_PREFIX]) {
      const opts = { maxDepth: 10, prefix }

      it(`suppresses ${prefix} when truncation changes a later expansion predicate`, () => {
        const huge = `{"pad":"${'x'.repeat(1_000_001)}"}`
        const input = { gate: huge, items: [{ encoded: '{"secret":"s3cret"}' }] }
        const config = {
          expand: ['$.gate', '$.items[?(@root.gate.length > 1000000)].encoded'],
          request: ['$.items[*].encoded.secret'],
          response: ['$.items[*].encoded.secret'],
        }

        assert.deepStrictEqual(computeTags(config, input, opts), {})
        assert.strictEqual(input.gate, huge)
        assert.strictEqual(input.items[0].encoded, '{"secret":"s3cret"}')
      })

      const leaves = [
        { name: 'Date', make: () => new Date() },
        { name: 'Map', make: () => new Map() },
        { name: 'Set', make: () => new Set() },
      ]
      for (const { name, make } of leaves) {
        it(`suppresses ${prefix} predicates on discarded ${name} fields`, () => {
          const leaf = Object.assign(make(), { flag: true })
          const input = { items: [{ leaf, secret: 's3cret' }] }
          const rule = '$.items[?(@.leaf.flag)].secret'
          const config = { expand: [], request: [rule], response: [rule] }

          assert.deepStrictEqual(computeTags(config, input, opts), {})
          const snapshot = createSafeSnapshot(leaf)
          assert.strictEqual(snapshot.incomplete, true)
          assert.strictEqual(Object.hasOwn(/** @type {object} */ (snapshot.value), 'flag'), false)
          assert.strictEqual(leaf.flag, true)
        })
      }

      for (const rule of [
        '$.items[?(@.toString)].secret',
        '$.items[?(@.hasOwnProperty)].secret',
        '$.items[?(typeof @.toString === "function")].secret',
      ]) {
        it(`preserves inherited members for ${prefix} rule ${rule}`, () => {
          const input = { items: [{ secret: 's3cret' }] }
          const config = { expand: [], request: [rule], response: [rule] }

          assert.deepStrictEqual(computeTags(config, input, opts), {
            [`${prefix}.items.0.secret`]: 'redacted',
          })
          assert.strictEqual(createSafeSnapshot(input).incomplete, false)
          assert.strictEqual(input.items[0].secret, 's3cret')
        })
      }

      for (const throwsOnSecond of [false, true]) {
        it(`reads enumerable getReader once for ${prefix} (second read throws: ${throwsOnSecond})`, () => {
          let reads = 0
          const input = Object.defineProperty({ safe: 'ok' }, 'getReader', {
            enumerable: true,
            get () {
              reads++
              if (throwsOnSecond && reads > 1) throw new Error('unexpected second read')
              return `read-${reads}`
            },
          })

          assert.deepStrictEqual(computeTags(safeConfig, input, opts), {
            [`${prefix}.safe`]: 'ok',
            [`${prefix}.getReader`]: 'read-1',
          })
          assert.strictEqual(reads, 1)
        })
      }
    }

    it('captures an enumerable getReader once in a complete snapshot', () => {
      let reads = 0
      const input = Object.defineProperty({ safe: 'ok' }, 'getReader', {
        enumerable: true,
        get () { return `read-${++reads}` },
      })
      const snapshot = createSafeSnapshot(input)

      assert.strictEqual(reads, 1)
      assert.strictEqual(snapshot.incomplete, false)
      assert.deepStrictEqual(snapshot.value, { safe: 'ok', getReader: 'read-1' })
    })
  })

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

  it('should not probe for streams on values rejected by structural checks', () => {
    let reads = 0
    const probe = () => {
      reads++
    }
    const cyclic = Object.defineProperty({}, 'getReader', { get: probe, enumerable: false })
    cyclic.self = cyclic
    let deep = Object.defineProperty({}, 'getReader', { get: probe, enumerable: false })
    for (let i = 0; i < 150; i++) {
      deep = { a: deep }
    }
    const longArray = new Array(10_001)
    Object.defineProperty(longArray, 'getReader', { get: probe, enumerable: false })

    const snapshot = createSafeSnapshot({ cyclic, deep, longArray })

    assert.strictEqual(snapshot.incomplete, true)
    // Detection never executes accessors, including on the first visit.
    assert.strictEqual(reads, 0)
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

  it('should bound the combined length of expanded JSON strings', () => {
    // 1,000,000 characters of expansion in total: the first two strings fit
    // exactly, the third would exceed the shared limit.
    const half = `{ "a": "${'x'.repeat(500_000 - 11)}" }`
    assert.strictEqual(half.length, 500_000)
    const config = { expand: ['$.body[*]'], request: [], response: [] }

    const tags = computeTags(config, { body: [half, half, '{ "a": 1 }'] }, { maxDepth: 10, prefix: 'foo' })

    assert.strictEqual(tags['foo.body.0.a'], 'x'.repeat(5000))
    assert.strictEqual(tags['foo.body.1.a'], 'x'.repeat(5000))
    assert.strictEqual(tags['foo.body.2'], 'truncated')
    assert.strictEqual(tags['_dd.payload_tags_incomplete'], true)
  })

  it('should share the entry budget between the payload and its expanded values', () => {
    // The payload admits the root, the array and 9,997 strings (9,999 entries),
    // leaving one entry: the first expansion's root fits, its child does not.
    const body = Array.from({ length: 9997 }, () => '{ "a": 1 }')
    const config = { expand: ['$.body[*]'], request: [], response: [] }

    const tags = computeTags(config, { body }, { maxDepth: 10, prefix: 'foo' })

    assert.strictEqual(tags['foo.body.0.a'], undefined)
    assert.strictEqual(tags['foo.body.1'], 'truncated')
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

  describe('expansion suppression boundaries', () => {
    /** @param {number} length */
    function encodedOfLength (length) {
      const overhead = '{"secret":"s3cret","pad":""}'.length
      return `{"secret":"s3cret","pad":"${'x'.repeat(length - overhead)}"}`
    }

    /** @param {number} depth */
    function deepEncoded (depth) {
      let json = '{"secret":"s3cret"}'
      for (let i = 0; i < depth; i++) json = `{"nested":${json}}`
      return json
    }

    const cases = [
      { name: 'individual length', encoded: () => [encodedOfLength(1_000_001)] },
      { name: 'cumulative length', encoded: () => [encodedOfLength(500_000), encodedOfLength(500_000), '{}'] },
      { name: 'shared entries', encoded: () => ['{"secret":"s3cret"}'], padding: 9995 },
      { name: 'expanded depth', encoded: () => [deepEncoded(100)] },
    ]

    for (const prefix of [PAYLOAD_TAG_REQUEST_PREFIX, PAYLOAD_TAG_RESPONSE_PREFIX]) {
      const opts = { maxDepth: 200, prefix }
      const phase = prefix === PAYLOAD_TAG_REQUEST_PREFIX ? 'request' : 'response'

      for (const testCase of cases) {
        for (const dependent of ['expand', 'redact', 'neither']) {
          it(`handles ${testCase.name} truncation with ${dependent} predicates on ${phase}`, () => {
            const items = testCase.encoded().map(encoded => ({ encoded }))
            const input = { items, safe: 'ok' }
            // Root, items, item, encoded, safe and padding cost six entries.
            if (testCase.padding) input.padding = new Array(testCase.padding - 1).fill('x')
            assert.strictEqual(createSafeSnapshot(input).incomplete, false)
            const original = items.map(item => item.encoded)
            const config = {
              expand: [dependent === 'expand' ? '$.items[?(@.encoded)].encoded' : '$.items[*].encoded'],
              request: [],
              response: [],
              [phase]: [dependent === 'redact' ? '$.items[?(@.encoded)].encoded' : '$..secret'],
            }

            const tags = computeTags(config, input, opts)

            if (dependent === 'neither') {
              assert.strictEqual(tags[`${prefix}.safe`], 'ok')
              assert.strictEqual(tags['_dd.payload_tags_incomplete'], true)
              assert.ok(!Object.values(tags).includes('s3cret'))
            } else {
              assert.deepStrictEqual(tags, {})
            }
            assert.deepStrictEqual(items.map(item => item.encoded), original)
          })
        }
      }

      for (const count of [2, 3]) {
        it(`accepts exactly 1,000,000 expanded units and rejects the next candidate on ${phase} (${count})`, () => {
          const half = encodedOfLength(500_000)
          assert.strictEqual(half.length, 500_000)
          const input = { items: Array.from({ length: count }, () => ({ encoded: half })) }
          const config = {
            expand: ['$.items[?(@.encoded)].encoded'], request: [], response: [], [phase]: ['$..secret'],
          }
          const tags = computeTags(config, input, opts)
          if (count === 2) {
            assert.strictEqual(tags[`${prefix}.items.0.encoded.secret`], 'redacted')
            assert.strictEqual(tags[`${prefix}.items.1.encoded.secret`], 'redacted')
            assert.strictEqual(tags['_dd.payload_tags_incomplete'], undefined)
          } else {
            assert.deepStrictEqual(tags, {})
          }
          assert.ok(input.items.every(item => item.encoded === half))
        })
      }

      for (const depth of [99, 100]) {
        it(`checks the last accepted and first rejected expanded object depth on ${phase} (${depth})`, () => {
          const encoded = deepEncoded(depth)
          const input = { items: [{ encoded }] }
          const config = {
            expand: ['$.items[?(@.encoded)].encoded'], request: [], response: [], [phase]: ['$..secret'],
          }
          const tags = computeTags(config, input, opts)
          if (depth === 99) {
            assert.ok(Object.values(tags).includes('redacted'))
            assert.strictEqual(tags['_dd.payload_tags_incomplete'], undefined)
          } else {
            assert.deepStrictEqual(tags, {})
          }
          assert.strictEqual(input.items[0].encoded, encoded)
        })
      }

      it(`suppresses initially incomplete captures with expansion predicates on ${phase}`, () => {
        const input = { items: [{ encoded: '{"secret":"s3cret"}' }], wide: new Array(10_001) }
        const config = { expand: ['$.items[?(@.encoded)].encoded'], request: [], response: [], [phase]: ['$..secret'] }
        assert.deepStrictEqual(computeTags(config, input, opts), {})
        assert.strictEqual(input.items[0].encoded, '{"secret":"s3cret"}')
      })

      it(`uses only the selected redaction rules after incomplete expansion on ${phase}`, () => {
        const other = phase === 'request' ? 'response' : 'request'
        const input = { body: encodedOfLength(1_000_001), safe: 'ok' }
        const config = {
          expand: ['$.body'], request: [], response: [], [phase]: ['$.safe'], [other]: ['$..[?(@.secret)]'],
        }
        assert.deepStrictEqual(computeTags(config, input, opts), {
          [`${prefix}.body`]: 'truncated',
          [`${prefix}.safe`]: 'redacted',
          '_dd.payload_tags_incomplete': true,
        })
      })
    }
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

  describe('ordinary snapshot prototypes', () => {
    const predicates = [
      '@.toString',
      '@.hasOwnProperty',
      'typeof @.toString === "function"',
      '@.hasOwnProperty("secret")',
      '@.toString() === "[object Object]"',
    ]
    for (const prefix of [PAYLOAD_TAG_REQUEST_PREFIX, PAYLOAD_TAG_RESPONSE_PREFIX]) {
      for (const predicate of predicates) {
        for (const expand of [false, true]) {
          it(`preserves ${predicate} for ${prefix} ${expand ? 'expansion' : 'redaction'}`, () => {
            const input = { items: [{ secret: 's3cret', encoded: '{"secret":"encoded-secret"}' }] }
            const rule = `$.items[?(${predicate})]`
            const config = {
              expand: expand ? [`${rule}.encoded`] : [],
              request: expand ? ['$.items[*].encoded.secret'] : [`${rule}.secret`],
              response: expand ? ['$.items[*].encoded.secret'] : [`${rule}.secret`],
            }
            const tags = computeTags(config, input, { maxDepth: 10, prefix })
            assert.strictEqual(tags[`${prefix}.items.0.${expand ? 'encoded.secret' : 'secret'}`], 'redacted')
            assert.strictEqual(tags['_dd.payload_tags_incomplete'], undefined)
            assert.deepStrictEqual(input.items[0], { secret: 's3cret', encoded: '{"secret":"encoded-secret"}' })
          })
        }
      }

      it(`lets own data shadow inherited members for ${prefix}`, () => {
        const input = { items: [{ toString: '', hasOwnProperty: false, secret: 's3cret' }] }
        const rules = ['$.items[?(@.toString)].secret', '$.items[?(@.hasOwnProperty)].secret']
        const tags = computeTags({ expand: [], request: rules, response: rules }, input, { maxDepth: 10, prefix })
        assert.strictEqual(tags[`${prefix}.items.0.secret`], 's3cret')
        assert.strictEqual(tags['_dd.payload_tags_incomplete'], undefined)
      })
    }

    for (const flavor of ['class', 'cross-realm', 'null-prototype', 'custom-prototype']) {
      it(`isolates ${flavor} inputs with ordinary native destination prototypes`, () => {
        const inspect = sinon.spy(() => { throw new Error('unexpected prototype getter') })
        const proto = Object.defineProperty({ detail: { secret: 's3cret' } }, 'inherited', { get: inspect })
        class Instance {}
        let source
        if (flavor === 'class') {
          source = new Instance()
        } else if (flavor === 'cross-realm') {
          source = nodeVm.runInNewContext('({})')
        } else {
          source = Object.create(flavor === 'null-prototype' ? null : proto)
        }
        source.secret = 's3cret'
        const snapshot = createSafeSnapshot({ a: source, b: source })
        const { a, b } = /** @type {Record<string, Record<string, unknown>>} */ (snapshot.value)

        assert.strictEqual(snapshot.incomplete, false)
        assert.strictEqual(Object.getPrototypeOf(a), Object.prototype)
        assert.strictEqual(Object.getPrototypeOf(b), Object.prototype)
        assert.notStrictEqual(a, source)
        assert.notStrictEqual(b, source)
        assert.notStrictEqual(a, b)
        assert.deepStrictEqual(a, { secret: 's3cret' })
        a.secret = 'local'
        assert.strictEqual(b.secret, 's3cret')
        assert.strictEqual(source.secret, 's3cret')
        assert.strictEqual(inspect.callCount, 0)
        assert.deepStrictEqual(proto.detail, { secret: 's3cret' })
        const rules = ['$.items[?(@.toString() === "[object Object]")].secret']
        for (const prefix of [PAYLOAD_TAG_REQUEST_PREFIX, PAYLOAD_TAG_RESPONSE_PREFIX]) {
          assert.deepStrictEqual(computeTags({ expand: [], request: rules, response: rules }, {
            items: [source],
          }, { maxDepth: 10, prefix }), { [`${prefix}.items.0.secret`]: 'redacted' })
        }
        assert.strictEqual(inspect.callCount, 0)
      })
    }
  })

  describe('__proto__ data isolation', () => {
    for (const array of [false, true]) {
      it(`protects ${array ? 'array' : 'ordinary'} destinations during copying, expansion and redaction`, () => {
        const input = array ? [] : {}
        Object.defineProperty(input, '__proto__', {
          enumerable: true,
          configurable: true,
          writable: true,
          value: '{"__proto__":{"secret":"s3cret","polluted":true},"safe":"ok"}',
        })
        const sourceProto = Object.getPrototypeOf(input)
        const objectDescriptors = Object.getOwnPropertyDescriptors(Object.prototype)
        const arrayDescriptors = Object.getOwnPropertyDescriptors(Array.prototype)
        const snapshot = createSafeSnapshot(input)
        const copy = /** @type {Record<string, unknown>} */ (snapshot.value)
        assert.strictEqual(snapshot.incomplete, false)
        assert.strictEqual(Object.getPrototypeOf(copy), array ? Array.prototype : Object.prototype)
        assert.ok(Object.hasOwn(copy, '__proto__'))
        assert.strictEqual(Reflect.get(copy, '__proto__'), Reflect.get(input, '__proto__'))
        const config = {
          expand: ['$.__proto__'],
          request: ['$.__proto__.__proto__.secret'],
          response: ['$.__proto__.__proto__.secret'],
        }
        const wrapped = { data: input }
        const tags = computeTags({
          expand: ['$.data.__proto__'],
          request: [],
          response: ['$.data.__proto__.__proto__.secret'],
        }, wrapped, responseOpts)
        assert.strictEqual(tags['aws.response.body.data.__proto__.__proto__.secret'], 'redacted')
        assert.strictEqual(tags['aws.response.body.data.__proto__.__proto__.polluted'], 'true')
        assert.strictEqual(tags['aws.response.body.data.__proto__.safe'], 'ok')
        assert.strictEqual(computeTags(config, input, responseOpts)['aws.response.body.__proto__.__proto__.secret'],
          'redacted')
        assert.strictEqual(Reflect.get(input, '__proto__'), Reflect.get(copy, '__proto__'))
        assert.strictEqual(Object.getPrototypeOf(input), sourceProto)
        assert.deepStrictEqual(Object.getOwnPropertyDescriptors(Object.prototype), objectDescriptors)
        assert.deepStrictEqual(Object.getOwnPropertyDescriptors(Array.prototype), arrayDescriptors)
      })

      it(`redacts own __proto__ data on an ${array ? 'array' : 'object'} without changing its prototype`, () => {
        const input = array ? ['tail'] : { safe: 'ok' }
        const data = JSON.parse('{"__proto__":{"secret":"s3cret"}}')
        Object.defineProperty(input, '__proto__', { enumerable: true, value: data })
        const snapshot = createSafeSnapshot(input)
        const copy = /** @type {Record<string, Record<string, unknown>>} */ (snapshot.value)
        assert.strictEqual(Object.getPrototypeOf(copy), array ? Array.prototype : Object.prototype)
        assert.ok(Object.hasOwn(copy, '__proto__'))
        assert.notStrictEqual(Reflect.get(copy, '__proto__'), data)
        assert.deepStrictEqual(Reflect.get(copy, '__proto__'), data)
        const config = { expand: [], request: ['$.__proto__'], response: ['$.__proto__.__proto__.secret'] }
        const tags = computeTags(config, input, responseOpts)
        assert.strictEqual(tags['aws.response.body.__proto__.__proto__.secret'], 'redacted')
        assert.strictEqual(computeTags(config, input, {
          maxDepth: 10, prefix: PAYLOAD_TAG_REQUEST_PREFIX,
        })['aws.request.body.__proto__'], 'redacted')
        assert.deepStrictEqual(data, JSON.parse('{"__proto__":{"secret":"s3cret"}}'))
        assert.ok(!('secret' in Object.prototype))
        assert.ok(!('secret' in Array.prototype))
      })
    }
  })

  describe('accessor-free stream detection', () => {
    for (const inherited of [false, true]) {
      it(`ignores ${inherited ? 'inherited' : 'non-enumerable'} getReader accessors`, () => {
        const getReader = sinon.spy(() => { throw new Error('unexpected stream probe') })
        const holder = Object.defineProperty({}, 'getReader', { get: getReader })
        const input = inherited
          ? Object.assign(Object.create(holder), { safe: 'ok' })
          : Object.assign(holder, { safe: 'ok' })
        const snapshot = createSafeSnapshot(input)
        assert.deepStrictEqual(snapshot.value, { safe: 'ok' })
        assert.strictEqual(snapshot.incomplete, false)
        assert.strictEqual(getReader.callCount, 0)
      })

      it(`truncates ${inherited ? 'inherited' : 'own'} callable data descriptors without invoking them`, () => {
        const getReader = sinon.spy(() => { throw new Error('unexpected stream method') })
        const holder = { getReader }
        const input = inherited ? Object.assign(Object.create(holder), { safe: 'ok' }) : holder
        const snapshot = createSafeSnapshot({ input, safe: 'ok' })
        assert.deepStrictEqual(snapshot.value, { input: 'truncated', safe: 'ok' })
        assert.strictEqual(snapshot.incomplete, true)
        assert.strictEqual(getReader.callCount, 0)
      })
    }

    it('lets own nonfunction data shadow an inherited getReader method', () => {
      const method = sinon.spy()
      const input = Object.assign(Object.create({ getReader: method }), { getReader: 'data', safe: 'ok' })
      const snapshot = createSafeSnapshot(input)
      assert.deepStrictEqual(snapshot.value, { getReader: 'data', safe: 'ok' })
      assert.strictEqual(snapshot.incomplete, false)
      assert.strictEqual(method.callCount, 0)
    })

    it('copies an admitted accessor returning a function, without treating it as native-stream evidence', () => {
      const method = sinon.spy()
      const getReader = sinon.spy(() => method)
      const input = Object.defineProperty({ safe: 'ok' }, 'getReader', { enumerable: true, get: getReader })
      const snapshot = createSafeSnapshot(input)
      assert.deepStrictEqual(snapshot.value, { safe: 'ok', getReader: method })
      assert.strictEqual(snapshot.incomplete, false)
      assert.strictEqual(getReader.callCount, 1)
      assert.strictEqual(method.callCount, 0)
    })

    it('omits a first-read throwing admitted accessor with a fixed payload-safe error', () => {
      const getReader = sinon.spy(() => { throw new Error('payload-secret') })
      const input = Object.defineProperty({ safe: 'ok' }, 'getReader', { enumerable: true, get: getReader })
      const diagnostic = sinon.stub(log, 'error')
      try {
        assert.deepStrictEqual(computeTags(safeConfig, input, responseOpts), {})
        assert.strictEqual(getReader.callCount, 1)
        assert.deepStrictEqual(diagnostic.args, [
          ['Error generating payload tags; omitting payload tags for this operation'],
        ])
      } finally {
        diagnostic.restore()
      }
    })

    for (const native of ['Node', 'web', 'web with foreign prototype']) {
      it(`keeps a ${native} stream opaque despite a hostile own getReader accessor`, async () => {
        const stream = native === 'Node'
          ? makeReadable()
          : new ReadableStream({
            start (controller) { controller.enqueue('chunk'); controller.close() },
          })
        // Node's web-stream implementation is shared between vm contexts.
        // A foreign prototype tests the native-brand fallback independently
        // of same-realm prototype recognition.
        if (native === 'web with foreign prototype') Object.setPrototypeOf(stream, nodeVm.runInNewContext('({})'))
        const getReader = sinon.spy(() => { throw new Error('unexpected native stream probe') })
        Object.defineProperty(stream, 'getReader', { enumerable: true, get: getReader })
        const snapshot = createSafeSnapshot({ stream, safe: 'ok' })
        assert.deepStrictEqual(snapshot.value, { stream: 'truncated', safe: 'ok' })
        assert.strictEqual(snapshot.incomplete, true)
        assert.strictEqual(getReader.callCount, 0)
        if (native === 'Node') {
          const readable = /** @type {Readable} */ (stream)
          assert.strictEqual(readable.readableLength, 5)
          assert.strictEqual(readable.readableFlowing, null)
          assert.strictEqual(readable.destroyed, false)
          assert.strictEqual(readable.listenerCount('data'), 0)
          assert.deepStrictEqual(readable.read(), Buffer.from('chunk'))
          readable.destroy()
        } else {
          const locked = Object.getOwnPropertyDescriptor(ReadableStream.prototype, 'locked')?.get
          assert.ok(locked)
          assert.strictEqual(locked.call(stream), false)
          const reader = /** @type {ReadableStreamDefaultReader} */ (/** @type {unknown} */ (
            ReadableStream.prototype.getReader.call(stream)
          ))
          assert.deepStrictEqual(await reader.read(), { value: 'chunk', done: false })
          assert.deepStrictEqual(await reader.read(), { value: undefined, done: true })
          reader.releaseLock()
        }
      })
    }

    it('recognizes a cross-realm inherited data-method stream-like value without calling it', () => {
      const input = nodeVm.runInNewContext('Object.assign(Object.create({ getReader () { throw 1 } }), { safe: "ok" })')
      assert.deepStrictEqual(createSafeSnapshot(input), { value: 'truncated', incomplete: true })
    })

    for (const depth of [100, 101]) {
      it(`checks the last accepted and first rejected stream-descriptor chain length (${depth})`, () => {
        let input = Object.create(null)
        for (let i = 1; i < depth; i++) input = Object.create(input)
        input.safe = 'ok'
        const snapshot = createSafeSnapshot(input)
        assert.strictEqual(snapshot.incomplete, depth === 101)
        assert.deepStrictEqual(snapshot.value, depth === 100 ? { safe: 'ok' } : 'truncated')
      })
    }

    it('bounds a deep reflected prototype chain without reading payload values', () => {
      const getReader = sinon.spy()
      let input = Object.defineProperty({}, 'getReader', { enumerable: true, get: getReader })
      for (let i = 0; i < 100; i++) input = Object.create(input)
      assert.deepStrictEqual(createSafeSnapshot(input), { value: 'truncated', incomplete: true })
      assert.strictEqual(getReader.callCount, 0)
    })

    it('fails soft if a cyclic Proxy prototype fails native binary brand detection before stream detection', () => {
      const cyclic = new Proxy({}, { getPrototypeOf () { return cyclic } })
      const diagnostic = sinon.stub(log, 'error')
      try {
        assert.deepStrictEqual(computeTags(safeConfig, cyclic, responseOpts), {})
        assert.deepStrictEqual(diagnostic.args, [
          ['Error generating payload tags; omitting payload tags for this operation'],
        ])
      } finally {
        diagnostic.restore()
      }
    })

    it('does not read enumerable stream accessors in depth- or array-length-rejected work', () => {
      const getReader = sinon.spy(() => { throw new Error('unexpected rejected read') })
      let deep = Object.defineProperty({}, 'getReader', { enumerable: true, get: getReader })
      for (let i = 0; i < 100; i++) deep = { child: deep }
      const array = new Array(10_001)
      Object.defineProperty(array, 'getReader', { enumerable: true, get: getReader })
      const snapshot = createSafeSnapshot({ deep, array })
      assert.strictEqual(snapshot.incomplete, true)
      assert.strictEqual(getReader.callCount, 0)
    })

    it('reads an admitted enumerable stream accessor once even with a cyclic back-reference', () => {
      const getReader = sinon.spy(() => 'data')
      const input = Object.defineProperty({}, 'getReader', { enumerable: true, get: getReader })
      Object.assign(input, { self: input })
      assert.deepStrictEqual(createSafeSnapshot(input), {
        value: { getReader: 'data', self: 'truncated' }, incomplete: true,
      })
      assert.strictEqual(getReader.callCount, 1)
    })

    it('shares admission work across snapshots without probing a late accessor', () => {
      const budget = createSnapshotBudget()
      const first = Object.fromEntries(Array.from({ length: 9999 }, (_, i) => [`k${i}`, i]))
      assert.strictEqual(createSafeSnapshot(first, budget).incomplete, false)
      assert.strictEqual(budget.entries, 0)
      const getReader = sinon.spy()
      const input = Object.defineProperty({}, 'getReader', { enumerable: true, get: getReader })
      assert.deepStrictEqual(createSafeSnapshot(input, budget), { value: 'truncated', incomplete: true })
      assert.strictEqual(getReader.callCount, 0)
    })

    it('never reads late getReader fields, pending siblings, or work rejected with zero budget', () => {
      const getReader = sinon.spy(() => { throw new Error('unexpected omitted read') })
      const late = Object.fromEntries(Array.from({ length: 9999 }, (_, i) => [`k${i}`, i]))
      Object.defineProperty(late, 'getReader', { enumerable: true, get: getReader })
      assert.strictEqual(createSafeSnapshot(late).incomplete, true)
      const pending = Object.defineProperty({}, 'getReader', { enumerable: true, get: getReader })
      const budget = createSnapshotBudget()
      budget.entries = 0
      assert.deepStrictEqual(createSafeSnapshot(pending, budget), { value: 'truncated', incomplete: true })
      const snapshot = createSafeSnapshot({ first: late, pending })
      assert.strictEqual(snapshot.incomplete, true)
      assert.ok(!Object.hasOwn(/** @type {object} */ (snapshot.value), 'pending'))
      assert.strictEqual(getReader.callCount, 0)
    })
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
        const input = Object.defineProperty({ safe: 'ok' }, 'boom', {
          enumerable: true,
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

  describe('opaque leaf isolation', () => {
    const kinds = [
      { name: 'Date', expression: 'new Date(1234)', make: () => new Date(1234), prototype: Date.prototype },
      { name: 'Map', expression: 'new Map()', make: () => new Map(), prototype: Map.prototype },
      { name: 'Set', expression: 'new Set()', make: () => new Set(), prototype: Set.prototype },
    ]

    for (const kind of kinds) {
      for (const flavor of ['native', 'subclass', 'cross-realm', 'cross-realm subclass']) {
        const makeLeaf = () => {
          if (flavor === 'cross-realm subclass') {
            return nodeVm.runInNewContext(`new (class extends ${kind.name} {})(${kind.name === 'Date' ? '1234' : ''})`)
          }
          if (flavor === 'cross-realm') return nodeVm.runInNewContext(kind.expression)
          if (flavor === 'subclass') {
            const Leaf = nodeVm.runInThisContext(`(class extends ${kind.name} {})`)
            return kind.name === 'Date' ? new Leaf(1234) : new Leaf()
          }
          return kind.make()
        }

        it(`does not redact or expand attached properties of a ${flavor} ${kind.name}`, () => {
          const leaf = makeLeaf()
          const detail = { secret: 's3cret', encoded: '{"secret":"encoded-secret"}' }
          leaf.detail = detail
          const input = { leaf, safe: 'ok' }
          const config = {
            expand: ['$.leaf.detail.encoded'],
            request: [],
            response: ['$.leaf.detail.secret', '$.leaf.detail.encoded.secret'],
          }

          const tags = computeTags(config, input, responseOpts)

          assert.strictEqual(leaf.detail, detail)
          assert.deepStrictEqual(detail, { secret: 's3cret', encoded: '{"secret":"encoded-secret"}' })
          assert.deepStrictEqual(tags, { 'aws.response.body.safe': 'ok', '_dd.payload_tags_incomplete': true })
          assert.deepStrictEqual(computeTags(config, input, {
            maxDepth: 10, prefix: PAYLOAD_TAG_REQUEST_PREFIX,
          }), { 'aws.request.body.safe': 'ok', '_dd.payload_tags_incomplete': true })
          assert.deepStrictEqual(computeTags(config, input, { ...responseOpts, maxDepth: 1 }), {
            'aws.response.body.leaf': 'truncated',
            'aws.response.body.safe': 'ok',
            '_dd.payload_tags_incomplete': true,
          })
        })

        it(`never traverses attached properties or hooks of a ${flavor} ${kind.name}`, () => {
          const leaf = makeLeaf()
          const stream = makeReadable()
          const inspect = sinon.spy(() => { throw new Error('unexpected leaf inspection') })
          leaf.detail = { stream, cycle: leaf, wide: new Array(20000).fill('ignored') }
          for (const key of ['getReader', 'constructor', 'getTime', 'size', Symbol.iterator, Symbol.toPrimitive]) {
            Object.defineProperty(leaf, key, { enumerable: true, get: inspect })
          }

          assert.deepStrictEqual(computeTags(safeConfig, { leaf, safe: 'ok' }, responseOpts), {
            'aws.response.body.safe': 'ok',
            '_dd.payload_tags_incomplete': true,
          })
          assert.strictEqual(inspect.callCount, 0)
          assert.strictEqual(stream.readableLength, 5)
          assert.strictEqual(stream.readableFlowing, null)
          assert.strictEqual(stream.destroyed, false)
          stream.destroy()
        })

        for (const prefix of [PAYLOAD_TAG_REQUEST_PREFIX, PAYLOAD_TAG_RESPONSE_PREFIX]) {
          for (const phase of ['redact', 'expand']) {
            it(`suppresses ${prefix} ${phase} predicates on attached fields of a ${flavor} ${kind.name}`, () => {
              const leaf = makeLeaf()
              leaf.flag = true
              const input = { items: [{ leaf, secret: 's3cret', encoded: '{"secret":"s3cret"}' }] }
              const rule = '$.items[?(@.leaf.flag)]'
              const config = {
                expand: phase === 'expand' ? [`${rule}.encoded`] : [],
                request: phase === 'redact' ? [`${rule}.secret`] : ['$.items[*].encoded.secret'],
                response: phase === 'redact' ? [`${rule}.secret`] : ['$.items[*].encoded.secret'],
              }

              assert.deepStrictEqual(computeTags(config, input, { maxDepth: 10, prefix }), {})
              const snapshot = createSafeSnapshot(leaf)
              assert.strictEqual(snapshot.incomplete, true)
              assert.strictEqual(Object.getPrototypeOf(snapshot.value), kind.prototype)
              assert.strictEqual(Object.hasOwn(/** @type {object} */ (snapshot.value), 'flag'), false)
              if (kind.name === 'Date') assert.strictEqual(Date.prototype.getTime.call(snapshot.value), 1234)
              assert.strictEqual(leaf.flag, true)
              assert.strictEqual(input.items[0].secret, 's3cret')
              assert.strictEqual(input.items[0].encoded, '{"secret":"s3cret"}')
            })
          }
        }

        it(`isolates repeated aliases of a ${flavor} ${kind.name}`, () => {
          const leaf = makeLeaf()
          const snapshot = createSafeSnapshot({ a: leaf, b: leaf })
          const { a, b } = /** @type {Record<string, object>} */ (snapshot.value)

          assert.strictEqual(snapshot.incomplete, false)
          assert.notStrictEqual(a, leaf)
          assert.notStrictEqual(b, leaf)
          assert.notStrictEqual(a, b)
          assert.strictEqual(Object.getPrototypeOf(a), kind.prototype)
          assert.strictEqual(Object.getPrototypeOf(b), kind.prototype)
          if (kind.name === 'Date') {
            assert.strictEqual(Date.prototype.getTime.call(a), 1234)
            Date.prototype.setTime.call(a, 9999)
            assert.strictEqual(Date.prototype.getTime.call(b), 1234)
            assert.strictEqual(Date.prototype.getTime.call(leaf), 1234)
          } else if (kind.name === 'Map') {
            Map.prototype.set.call(a, 'local', 'value')
            assert.strictEqual(Map.prototype.has.call(b, 'local'), false)
            assert.strictEqual(Map.prototype.has.call(leaf, 'local'), false)
          } else {
            Set.prototype.add.call(a, 'local')
            assert.strictEqual(Set.prototype.has.call(b, 'local'), false)
            assert.strictEqual(Set.prototype.has.call(leaf, 'local'), false)
          }
        })
      }
    }

    it('preserves an invalid Date without invoking conversion hooks', () => {
      const date = new Date(NaN)
      const snapshot = createSafeSnapshot(date)
      assert.notStrictEqual(snapshot.value, date)
      assert.ok(Number.isNaN(Date.prototype.getTime.call(snapshot.value)))
      assert.strictEqual(snapshot.incomplete, false)
    })

    for (const name of ['Map', 'Set']) {
      it(`discards nonempty ${name} contents without iteration and flags structural captures`, () => {
        const stream = makeReadable()
        const leaf = name === 'Map' ? new Map([['key', stream]]) : new Set([stream])
        const inspect = sinon.spy(() => { throw new Error('unexpected collection inspection') })
        for (const key of ['size', 'entries', 'values', Symbol.iterator]) {
          Object.defineProperty(leaf, key, { get: inspect })
        }
        const snapshot = createSafeSnapshot(leaf)
        assert.notStrictEqual(snapshot.value, leaf)
        assert.deepStrictEqual(Array.from(/** @type {Set<unknown>} */ (snapshot.value)), [])
        assert.strictEqual(snapshot.incomplete, true)
        assert.deepStrictEqual(computeTags({ ...safeConfig, response: ['$.secret'] }, {
          leaf, secret: 's3cret', safe: 'ok',
        }, responseOpts), {
          'aws.response.body.secret': 'redacted',
          'aws.response.body.safe': 'ok',
          '_dd.payload_tags_incomplete': true,
        })
        assert.strictEqual(inspect.callCount, 0)
        assert.strictEqual(stream.readableLength, 5)
        assert.strictEqual(stream.destroyed, false)
        stream.destroy()
      })

      for (const phase of ['expand', 'response']) {
        it(`suppresses ${name} captures when ${phase} predicates depend on discarded contents`, () => {
          const leaf = name === 'Map' ? new Map([['key', 'value']]) : new Set(['value'])
          const input = { items: [{ leaf, secret: 's3cret', encoded: '{"secret":"encoded-secret"}' }] }
          const rule = phase === 'expand'
            ? '$.items[?(@.leaf.size > 0)].encoded'
            : '$.items[?(@.leaf.size > 0)].secret'
          const config = { ...safeConfig, [phase]: [rule] }

          assert.deepStrictEqual(computeTags(config, input, responseOpts), {})
          assert.strictEqual(input.items[0].secret, 's3cret')
          assert.strictEqual(input.items[0].encoded, '{"secret":"encoded-secret"}')
        })
      }
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

    it('should keep the rendered prefix of a Buffer at the first byte beyond the copy budget', () => {
      const body = Buffer.alloc(1_000_001, 120)
      const tags = computeTags(safeConfig, { Body: body }, responseOpts)

      assert.strictEqual(tags['aws.response.body.Body'], 'x'.repeat(5000))
      assert.strictEqual(tags['_dd.payload_tags_incomplete'], true)
    })

    it('should copy only the rendered prefix of an over-budget Buffer', () => {
      const snapshot = createSafeSnapshot({ Body: Buffer.alloc(1_000_001, 120) })

      assert.strictEqual(snapshot.incomplete, true)
      const copy = /** @type {{ Body: Buffer }} */ (snapshot.value).Body
      assert.ok(Buffer.isBuffer(copy))
      assert.strictEqual(copy.byteLength, 15_004)
    })

    const overBudgetEncodings = /** @type {Array<[string, Buffer]>} */ ([
      ['three-byte characters', Buffer.from('\u20ac'.repeat(400_000))],
      ['four-byte characters', Buffer.from('\u{1F600}'.repeat(300_000))],
      ['invalid bytes', Buffer.alloc(1_000_001, 0xff)],
      ['truncated multi-byte sequences', Buffer.from('e282'.repeat(600_000), 'hex')],
      ['a sequence split at the prefix boundary', Buffer.concat([
        Buffer.alloc(15_002, 120),
        Buffer.from('\u{1F600}'.repeat(300_000)),
      ])],
    ])
    for (const [name, body] of overBudgetEncodings) {
      it(`should render an over-budget Buffer prefix like the full Buffer for ${name}`, () => {
        const expected = tagsFromObject({ Body: body }, responseOpts)['aws.response.body.Body']
        const tags = computeTags(safeConfig, { Body: body }, responseOpts)

        assert.strictEqual(tags['aws.response.body.Body'], expected)
        assert.strictEqual(tags['_dd.payload_tags_incomplete'], true)
      })
    }

    it('should reject a typed array at the first byte beyond the copy budget', () => {
      const tags = computeTags(safeConfig, { Body: new Uint8Array(1_000_001) }, responseOpts)

      assert.deepStrictEqual(tags, {
        'aws.response.body.Body': 'truncated',
        '_dd.payload_tags_incomplete': true,
      })
    })

    it('should keep an over-budget Buffer prefix within the remaining aggregate budget', () => {
      const first = Buffer.alloc(600_000, 97)
      const second = Buffer.alloc(600_000, 98)

      const tags = computeTags(safeConfig, { a: first, b: second }, responseOpts)

      assert.strictEqual(tags['aws.response.body.a'], 'a'.repeat(5000))
      assert.strictEqual(tags['aws.response.body.b'], 'b'.repeat(5000))
      assert.strictEqual(tags['_dd.payload_tags_incomplete'], true)
      // The oversized second value must not have consumed the first one.
      assert.strictEqual(first[0], 97)
      assert.strictEqual(second[0], 98)
    })

    it('should truncate an over-budget Buffer when its prefix exceeds the remaining budget', () => {
      // 15,003 bytes remain: one byte short of the 15,004-byte prefix.
      const first = Buffer.alloc(984_997, 97)
      const second = Buffer.alloc(600_000, 98)
      const third = Buffer.alloc(15_003, 99)

      const tags = computeTags(safeConfig, { a: first, b: second, c: third }, responseOpts)

      assert.strictEqual(tags['aws.response.body.a'], 'a'.repeat(5000))
      assert.strictEqual(tags['aws.response.body.b'], 'truncated')
      assert.strictEqual(tags['aws.response.body.c'], 'c'.repeat(5000))
      assert.strictEqual(tags['_dd.payload_tags_incomplete'], true)
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

    const detachedLeafTags = {
      'aws.response.body.Body': 'truncated',
      'aws.response.body.Ok': 'true',
      '_dd.payload_tags_incomplete': true,
    }

    it('should truncate only the leaf when a typed-array buffer is detached', () => {
      const body = new Uint8Array([1, 2])
      structuredClone(body.buffer, { transfer: [body.buffer] })

      assert.deepStrictEqual(computeTags(safeConfig, { Body: body, Ok: true }, responseOpts), detachedLeafTags)
    })

    for (const visibleLength of [0, 3]) {
      it(`should truncate only the leaf of a detached DataView with ${visibleLength} visible bytes`, () => {
        const backing = new ArrayBuffer(3)
        const body = new DataView(backing, 0, visibleLength)
        structuredClone(backing, { transfer: [backing] })

        const snapshot = createSafeSnapshot({ Body: body, Ok: true })
        assert.strictEqual(snapshot.incomplete, true)
        assert.deepStrictEqual({ ...(/** @type {object} */ (snapshot.value)) }, { Body: 'truncated', Ok: true })

        assert.deepStrictEqual(computeTags(safeConfig, { Body: body, Ok: true }, responseOpts), detachedLeafTags)
      })
    }

    for (const name of ['typed-array', 'Buffer']) {
      it(`should truncate only the leaf when an originally empty ${name} view is detached`, () => {
        const backing = new ArrayBuffer(3)
        /** @type {Uint8Array | Buffer} */
        const body = name === 'Buffer' ? Buffer.from(backing, 1, 0) : new Uint8Array(backing, 1, 0)
        structuredClone(backing, { transfer: [backing] })

        assert.deepStrictEqual(computeTags(safeConfig, { Body: body, Ok: true }, responseOpts), detachedLeafTags)
      })
    }

    it('should keep partial tags and flag incompleteness when a binary value exceeds the budget', () => {
      const body = Buffer.alloc(1_000_001, 120)
      const config = { expand: [], request: ['$.Ok'], response: [] }

      const tags = computeTags(config, { Body: body, Ok: true }, requestOpts)

      assert.strictEqual(tags['aws.request.body.Ok'], 'redacted')
      assert.strictEqual(tags['aws.request.body.Body'], 'x'.repeat(5000))
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

    it('should bound an oversized Buffer that spoofs byteLength to its rendered prefix', () => {
      const body = Buffer.alloc(1_000_001)
      Object.defineProperty(body, 'byteLength', { value: 0 })

      const snapshot = createSafeSnapshot({ Body: body })

      assert.strictEqual(snapshot.incomplete, true)
      assert.strictEqual(/** @type {{ Body: Buffer }} */ (snapshot.value).Body.byteLength, 15_004)
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
      'Omitting payload tags: expansion was truncated and the rules are data-dependent'

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

    it('emits only the fixed payload-safe expansion diagnostic when expansion predicates are suppressed', () => {
      const debug = sinon.stub(log, 'debug')
      const error = sinon.stub(log, 'error')
      const huge = `{"pad":"${'x'.repeat(1_000_001)}"}`
      const config = {
        expand: ['$.gate', '$.items[?(@root.gate.length > 1000000)].encoded'],
        request: [],
        response: ['$.items[*].encoded.secret'],
      }
      assert.deepStrictEqual(computeTags(config, {
        gate: huge, items: [{ encoded: '{"secret":"s3cret"}' }],
      }, responseOpts), {})
      assert.deepStrictEqual(debug.args, [[expansionMessage]])
      assert.strictEqual(error.callCount, 0)
    })

    it('should not emit a suppression diagnostic for successful captures', () => {
      const debug = sinon.stub(log, 'debug')

      computeTags(safeConfig, { ETag: '"etag"' }, responseOpts)

      assert.strictEqual(debug.getCalls().length, 0)
    })
  })
})
