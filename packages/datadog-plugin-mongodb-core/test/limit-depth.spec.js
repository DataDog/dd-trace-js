'use strict'

const assert = require('node:assert/strict')
const vm = require('node:vm')

const { describe, it } = require('mocha')
const sinon = require('sinon')

const MongodbCorePlugin = require('../src/query')

// The sanitisation helpers are module-private; exercise them through `bindStart`,
// which surfaces their output as `meta['mongodb.query']`.
function callBindStart (ctx, configOverride) {
  const startSpan = sinon.stub().returns({ finish () {} })
  const self = {
    config: {
      heartbeatEnabled: true,
      queryInResourceName: false,
      obfuscateQuery: 'none',
      ...configOverride,
    },
    operationName: () => 'mongodb.query',
    serviceName: () => ({ name: 'svc' }),
    startSpan,
    injectDbmComment: () => undefined,
  }
  MongodbCorePlugin.prototype.bindStart.call(self, ctx)
  return startSpan.firstCall.args[1].meta['mongodb.query']
}

describe('mongodb-core query depth limiter', () => {
  it('does not walk inherited prototype keys on the query input', () => {
    const polluted = Object.create({ inheritedKey: 'leak' })
    polluted.ownKey = 'kept'

    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: polluted },
      name: 'find',
    })

    assert.deepStrictEqual(JSON.parse(query), { ownKey: 'kept' })
  })

  it('does not walk inherited prototype keys on a nested object', () => {
    const nested = Object.create({ inheritedNested: 'leak' })
    nested.ownNested = 'kept'

    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { outer: nested } },
      name: 'find',
    })

    assert.deepStrictEqual(JSON.parse(query), { outer: { ownNested: 'kept' } })
  })

  it('extracts cmd.filter when no .query is present', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { filter: { user: 'alice' } },
      name: 'find',
    })

    assert.deepStrictEqual(JSON.parse(query), { user: 'alice' })
  })

  it('extracts cmd.pipeline when no .query / .filter is present', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { pipeline: [{ $match: { user: 'alice' } }, { $count: 'total' }] },
      name: 'aggregate',
    })

    assert.deepStrictEqual(JSON.parse(query), [
      { $match: { user: 'alice' } },
      { $count: 'total' },
    ])
  })

  it('extracts the inner q from a single cmd.deletes statement', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { deletes: [{ q: { user: 'alice' }, limit: 1 }] },
      name: 'delete',
    })

    assert.deepStrictEqual(JSON.parse(query), { user: 'alice' })
  })

  it('collects every q from multi-statement cmd.updates', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: {
        updates: [
          { q: { user: 'alice' }, u: { $set: { a: 1 } } },
          { q: { user: 'bob' }, u: { $set: { b: 2 } } },
        ],
      },
      name: 'update',
    })

    assert.deepStrictEqual(JSON.parse(query), [
      { user: 'alice' },
      { user: 'bob' },
    ])
  })

  it('renders Binary BSON values as "?" even when toJSON flattens to a base64 string', () => {
    // Mirrors bson@>=4 Binary.prototype.toJSON.
    const binary = {
      _bsontype: 'Binary',
      buffer: Buffer.from('payload'),
      toJSON () { return this.buffer.toString('base64') },
    }
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { blob: binary } },
      name: 'find',
    })

    assert.deepStrictEqual(JSON.parse(query), { blob: '?' })
  })

  it('coerces bigint leaves to their decimal string with obfuscation off', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { _id: 9999999999999999999999n } },
      name: 'find',
    })

    assert.deepStrictEqual(JSON.parse(query), { _id: '9999999999999999999999' })
  })

  it('collapses cycles to "?"', () => {
    const circular = { a: 1 }
    circular.self = circular

    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: circular },
      name: 'find',
    })

    assert.deepStrictEqual(JSON.parse(query), { a: 1, self: '?' })
  })

  it('preserves sibling objects under the slow none path', () => {
    // The bigint disqualifies canStringifyDirect so the JSON.stringify replacer runs.
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { a: { b: 1 }, c: { d: 2 }, big: 9n } },
      name: 'find',
    })

    assert.deepStrictEqual(JSON.parse(query), { a: { b: 1 }, c: { d: 2 }, big: '9' })
  })

  it('does not throw when a property getter returns a different value on the second read', () => {
    // JSON.stringify snapshots the first read into `value` and passes the parent
    // as `this` to the replacer; reading `this[key]` again can yield a different
    // result for non-pure getters / Proxies. The replacer must not assume the
    // second read is non-nullish.
    let reads = 0
    const flaky = {}
    Object.defineProperty(flaky, 'volatile', {
      enumerable: true,
      get () {
        reads += 1
        return reads === 1 ? { nested: 'value' } : undefined
      },
    })

    const query = callBindStart({
      ns: 'db.coll',
      // The leading bigint disqualifies canStringifyDirect on its first
      // iteration so the slow path's JSON.stringify replacer sees the getter,
      // not the precheck (which would consume the first read and mask the bug).
      ops: { query: { big: 9n, outer: flaky } },
      name: 'find',
    })

    assert.deepStrictEqual(JSON.parse(query), {
      big: '9',
      outer: { volatile: { nested: 'value' } },
    })
  })

  it('drops functions and renders non-Binary BSON values in the slow none path', () => {
    // The bigint forces the slow none path; MinKey has no toJSON so the walker
    // falls into the BSON sentinel branch.
    const minKey = { _bsontype: 'MinKey' }
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { boundary: minKey, drop: () => {}, big: 9n } },
      name: 'find',
    })

    assert.deepStrictEqual(JSON.parse(query), { boundary: '?', big: '9' })
  })

  it('renders toJSON-flattened BSON wrappers and primitive leaves in the slow none path', () => {
    // The bigint forces the slow path past canStringifyDirect; the rest of the
    // input exercises every leaf branch of the walker:
    //   - ObjectId / Date  → toJSON returns a primitive string
    //   - Decimal128 / Timestamp → toJSON returns a small wrapper object that gets walked
    //   - flag             → boolean leaf
    //   - bytes            → number / NaN array elements
    //   - circular         → self-referencing toJSON (collapses to "?")
    const objectId = { _bsontype: 'ObjectId', toJSON: () => '5f47ac9e2c2f4a0001a1b2c3' }
    const decimal = { _bsontype: 'Decimal128', toJSON: () => ({ $numberDecimal: '12.34' }) }
    const timestamp = { _bsontype: 'Timestamp', toJSON: () => ({ $timestamp: '1' }) }
    const cycle = {}
    cycle.toJSON = () => cycle

    const query = callBindStart({
      ns: 'db.coll',
      ops: {
        query: {
          _id: objectId,
          createdAt: new Date('2020-01-01T00:00:00Z'),
          price: decimal,
          version: timestamp,
          flag: true,
          bytes: [1, 2, Number.NaN, Number.POSITIVE_INFINITY],
          circular: cycle,
          big: 9n,
        },
      },
      name: 'find',
    })

    assert.deepStrictEqual(JSON.parse(query), {
      _id: '5f47ac9e2c2f4a0001a1b2c3',
      createdAt: '2020-01-01T00:00:00.000Z',
      price: { $numberDecimal: '12.34' },
      version: { $timestamp: '1' },
      flag: true,
      bytes: [1, 2, null, null],
      circular: '?',
      big: '9',
    })
  })

  it('collapses depth past MAX_DEPTH to "?"', () => {
    let nested = { leaf: 'value' }
    for (let i = 0; i < 20; i++) {
      nested = { inner: nested }
    }

    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: nested },
      name: 'find',
    })

    let walk = JSON.parse(query)
    let depth = 0
    while (typeof walk === 'object' && walk !== null && walk.inner !== undefined) {
      walk = walk.inner
      depth++
    }
    assert.strictEqual(walk, '?')
    assert.ok(depth >= 1 && depth <= 20, `unexpected depth before collapse: ${depth}`)
  })
})

describe('mongodb-core query obfuscation (redact mode)', () => {
  it('replaces primitive leaves with "?"', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { user: 'alice', age: 30, active: true } },
      name: 'find',
    }, { obfuscateQuery: 'redact' })

    assert.deepStrictEqual(JSON.parse(query), { user: '?', age: '?', active: '?' })
  })

  it('replaces null leaves with "?"', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { deleted: null, age: 0, name: '' } },
      name: 'find',
    }, { obfuscateQuery: 'redact' })

    assert.deepStrictEqual(JSON.parse(query), { deleted: '?', age: '?', name: '?' })
  })

  it('preserves operator keys but redacts their values', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { age: { $gte: 18, $lte: 65 }, status: { $in: ['active', 'pending'] } } },
      name: 'find',
    }, { obfuscateQuery: 'redact' })

    assert.deepStrictEqual(JSON.parse(query), {
      age: { $gte: '?', $lte: '?' },
      status: { $in: ['?', '?'] },
    })
  })

  it('coerces bigint leaves to "?"', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { _id: 9999999999999999999999n } },
      name: 'find',
    }, { obfuscateQuery: 'redact' })

    assert.deepStrictEqual(JSON.parse(query), { _id: '?' })
  })

  it('redacts toJSON-flattened BSON values (ObjectId-shaped) as "?"', () => {
    const objectId = { _bsontype: 'ObjectId', toJSON: () => '123456781234567812345678' }
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { _id: objectId } },
      name: 'find',
    }, { obfuscateQuery: 'redact' })

    assert.deepStrictEqual(JSON.parse(query), { _id: '?' })
  })

  it('still renders Binary BSON values as "?"', () => {
    const binary = { _bsontype: 'Binary', buffer: Buffer.from('payload') }
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { blob: binary } },
      name: 'find',
    }, { obfuscateQuery: 'redact' })

    assert.deepStrictEqual(JSON.parse(query), { blob: '?' })
  })

  it('redacts every TypedArray view as "?"', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: {
        query: {
          u8: new Uint8Array(4),
          f32: new Float32Array(4),
          bi64: new BigInt64Array(4),
          dv: new DataView(new ArrayBuffer(8)),
        },
      },
      name: 'find',
    }, { obfuscateQuery: 'redact' })

    assert.deepStrictEqual(JSON.parse(query), { u8: '?', f32: '?', bi64: '?', dv: '?' })
  })

  it('redacts BSON internal types without toJSON as "?"', () => {
    // MinKey, MaxKey, and Long don't implement Symbol.toPrimitive / toJSON, so
    // JSON.stringify would call their default Object#toString or leave them as
    // empty objects. Mirror master and collapse to the sentinel.
    const minKey = { _bsontype: 'MinKey' }
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { boundary: minKey } },
      name: 'find',
    }, { obfuscateQuery: 'redact' })

    assert.deepStrictEqual(JSON.parse(query), { boundary: '?' })
  })

  it('preserves pipeline operator shapes while redacting leaves', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: {
        pipeline: [
          { $match: { user: 'alice', age: { $gte: 18 } } },
          { $count: 'total' },
        ],
      },
      name: 'aggregate',
    }, { obfuscateQuery: 'redact' })

    assert.deepStrictEqual(JSON.parse(query), [
      { $match: { user: '?', age: { $gte: '?' } } },
      { $count: '?' },
    ])
  })

  it('redacts Date values via their toJSON marker', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { createdAt: new Date('2020-01-01') } },
      name: 'find',
    }, { obfuscateQuery: 'redact' })

    assert.deepStrictEqual(JSON.parse(query), { createdAt: '?' })
  })

  it('preserves Timestamp / Decimal128 wrapper shapes while redacting leaves', () => {
    // Mirrors bson@>=4 Timestamp.prototype.toJSON / Decimal128.prototype.toJSON,
    // both of which return a single-key wrapper object. Master walked into that
    // wrapper and redacted only the leaf; collapsing the whole value to "?"
    // merges distinct query signatures.
    const timestamp = { _bsontype: 'Timestamp', toJSON: () => ({ $timestamp: '0' }) }
    const decimal = { _bsontype: 'Decimal128', toJSON: () => ({ $numberDecimal: '12.34' }) }
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { _time: timestamp, price: decimal } },
      name: 'find',
    }, { obfuscateQuery: 'redact' })

    assert.deepStrictEqual(JSON.parse(query), {
      _time: { $timestamp: '?' },
      price: { $numberDecimal: '?' },
    })
  })

  it('collapses depth past MAX_DEPTH in redact mode', () => {
    let nested = { leaf: 'value' }
    for (let i = 0; i < 20; i++) {
      nested = { inner: nested }
    }

    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: nested },
      name: 'find',
    }, { obfuscateQuery: 'redact' })

    let walk = JSON.parse(query)
    while (typeof walk === 'object' && walk !== null && walk.inner !== '?') {
      walk = walk.inner
    }
    assert.strictEqual(walk.inner, '?')
  })

  it('redacts each q across multi-statement updates', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: {
        updates: [
          { q: { user: 'alice' }, u: { $set: { a: 1 } } },
          { q: { user: 'bob' }, u: { $set: { b: 2 } } },
        ],
      },
      name: 'update',
    }, { obfuscateQuery: 'redact' })

    assert.deepStrictEqual(JSON.parse(query), [
      { user: '?' },
      { user: '?' },
    ])
  })

  it('keeps verbatim values when obfuscateQuery is "none" (regression for default off)', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { user: 'alice', age: 30 } },
      name: 'find',
    }, { obfuscateQuery: 'none' })

    assert.deepStrictEqual(JSON.parse(query), { user: 'alice', age: 30 })
  })

  it('redacts a top-level Buffer as "?"', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { filter: Buffer.alloc(64, 0x42) },
      name: 'find',
    }, { obfuscateQuery: 'redact' })

    assert.strictEqual(query, '"?"')
  })

  it('redacts a wrapper-class toJSON that returns a Buffer as "?"', () => {
    // Pins the post-toJSON re-screen for redact mode: the wrapper has no own
    // enumerable properties, so the walker would otherwise descend into the
    // returned Buffer once toJSON resolves it.
    const state = new WeakMap()
    class PhotoQuery {
      constructor (photo) { state.set(this, photo) }
      toJSON () { return state.get(this) }
    }

    const query = callBindStart({
      ns: 'db.coll',
      ops: { filter: { photo: new PhotoQuery(Buffer.alloc(64, 0x42)) } },
      name: 'find',
    }, { obfuscateQuery: 'redact' })

    assert.deepStrictEqual(JSON.parse(query), { photo: '?' })
  })

  it('redacts a RegExp value as "?"', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { name: /^a$/i } },
      name: 'find',
    }, { obfuscateQuery: 'redact' })

    assert.deepStrictEqual(JSON.parse(query), { name: '?' })
  })

  it('redacts the leaves of a Map rendered as its entries', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { m: new Map([['a', 1], ['b', 2]]) } },
      name: 'find',
    }, { obfuscateQuery: 'redact' })

    assert.deepStrictEqual(JSON.parse(query), { m: { a: '?', b: '?' } })
  })
})

describe('mongodb-core query obfuscation (types mode)', () => {
  it('replaces primitive leaves with their typeof name', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { user: 'alice', age: 30, active: true } },
      name: 'find',
    }, { obfuscateQuery: 'types' })

    assert.deepStrictEqual(JSON.parse(query), { user: 'string', age: 'number', active: 'boolean' })
  })

  it('reports null leaves as "null"', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { deleted: null, age: 0, name: '' } },
      name: 'find',
    }, { obfuscateQuery: 'types' })

    assert.deepStrictEqual(JSON.parse(query), { deleted: 'null', age: 'number', name: 'string' })
  })

  it('preserves operator keys but reports value types', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { age: { $gte: 18, $lte: 65 }, status: { $in: ['active', 'pending'] } } },
      name: 'find',
    }, { obfuscateQuery: 'types' })

    assert.deepStrictEqual(JSON.parse(query), {
      age: { $gte: 'number', $lte: 'number' },
      status: { $in: ['string', 'string'] },
    })
  })

  it('reports bigint leaves as "bigint"', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { _id: 9999999999999999999999n } },
      name: 'find',
    }, { obfuscateQuery: 'types' })

    assert.deepStrictEqual(JSON.parse(query), { _id: 'bigint' })
  })

  it('reports toJSON-flattened BSON values (ObjectId-shaped) as "object"', () => {
    const objectId = { _bsontype: 'ObjectId', toJSON: () => '123456781234567812345678' }
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { _id: objectId } },
      name: 'find',
    }, { obfuscateQuery: 'types' })

    assert.deepStrictEqual(JSON.parse(query), { _id: 'object' })
  })

  it('reports Binary BSON values as "object"', () => {
    const binary = { _bsontype: 'Binary', buffer: Buffer.from('payload') }
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { blob: binary } },
      name: 'find',
    }, { obfuscateQuery: 'types' })

    assert.deepStrictEqual(JSON.parse(query), { blob: 'object' })
  })

  it('reports every TypedArray view as "object"', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: {
        query: {
          u8: new Uint8Array(4),
          f32: new Float32Array(4),
          bi64: new BigInt64Array(4),
          dv: new DataView(new ArrayBuffer(8)),
        },
      },
      name: 'find',
    }, { obfuscateQuery: 'types' })

    assert.deepStrictEqual(JSON.parse(query), { u8: 'object', f32: 'object', bi64: 'object', dv: 'object' })
  })

  it('reports BSON internal types without toJSON as "object"', () => {
    const minKey = { _bsontype: 'MinKey' }
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { boundary: minKey } },
      name: 'find',
    }, { obfuscateQuery: 'types' })

    assert.deepStrictEqual(JSON.parse(query), { boundary: 'object' })
  })

  it('collapses cycles to "object"', () => {
    const circular = { a: 1 }
    circular.self = circular

    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: circular },
      name: 'find',
    }, { obfuscateQuery: 'types' })

    assert.deepStrictEqual(JSON.parse(query), { a: 'number', self: 'object' })
  })

  it('reports array elements of every primitive type', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { mixed: ['s', 1, true, null, 9n] } },
      name: 'find',
    }, { obfuscateQuery: 'types' })

    assert.deepStrictEqual(JSON.parse(query), {
      mixed: ['string', 'number', 'boolean', 'null', 'bigint'],
    })
  })

  it('emits null for array elements JSON drops (undefined kept, function / symbol nulled)', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { items: ['ok', undefined, () => {}, Symbol('x'), 'tail'] } },
      name: 'find',
    }, { obfuscateQuery: 'types' })

    assert.deepStrictEqual(JSON.parse(query), {
      items: ['string', 'undefined', null, null, 'string'],
    })
  })

  it('drops function- and symbol-valued object fields', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { keep: 1, drop: () => {}, sym: Symbol('x') } },
      name: 'find',
    }, { obfuscateQuery: 'types' })

    assert.deepStrictEqual(JSON.parse(query), { keep: 'number' })
  })

  it('reports undefined object fields by their typeof name', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { u: undefined } },
      name: 'find',
    }, { obfuscateQuery: 'types' })

    assert.deepStrictEqual(JSON.parse(query), { u: 'undefined' })
  })

  it('reports Date values as "object" via their toJSON marker', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { createdAt: new Date('2020-01-01') } },
      name: 'find',
    }, { obfuscateQuery: 'types' })

    assert.deepStrictEqual(JSON.parse(query), { createdAt: 'object' })
  })

  it('preserves Timestamp / Decimal128 wrapper shapes while typing leaves', () => {
    const timestamp = { _bsontype: 'Timestamp', toJSON: () => ({ $timestamp: '0' }) }
    const decimal = { _bsontype: 'Decimal128', toJSON: () => ({ $numberDecimal: '12.34' }) }
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { _time: timestamp, price: decimal } },
      name: 'find',
    }, { obfuscateQuery: 'types' })

    assert.deepStrictEqual(JSON.parse(query), {
      _time: { $timestamp: 'string' },
      price: { $numberDecimal: 'string' },
    })
  })

  it('recurses into nested objects inside arrays', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { pipeline: [{ $match: { user: 'alice' } }, { $count: 'total' }] },
      name: 'aggregate',
    }, { obfuscateQuery: 'types' })

    assert.deepStrictEqual(JSON.parse(query), [
      { $match: { user: 'string' } },
      { $count: 'string' },
    ])
  })

  it('reports a top-level Buffer as "object"', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { filter: Buffer.alloc(64, 0x42) },
      name: 'find',
    }, { obfuscateQuery: 'types' })

    assert.strictEqual(query, '"object"')
  })

  it('reports a wrapper-class toJSON that returns a Buffer as "object"', () => {
    const state = new WeakMap()
    class PhotoQuery {
      constructor (photo) { state.set(this, photo) }
      toJSON () { return state.get(this) }
    }

    const query = callBindStart({
      ns: 'db.coll',
      ops: { filter: { photo: new PhotoQuery(Buffer.alloc(64, 0x42)) } },
      name: 'find',
    }, { obfuscateQuery: 'types' })

    assert.deepStrictEqual(JSON.parse(query), { photo: 'object' })
  })

  it('reports a RegExp value as "object"', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { name: /^a$/i } },
      name: 'find',
    }, { obfuscateQuery: 'types' })

    assert.deepStrictEqual(JSON.parse(query), { name: 'object' })
  })

  it('reports the leaf types of a Map rendered as its entries', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { m: new Map([['a', 1], ['b', 'two']]) } },
      name: 'find',
    }, { obfuscateQuery: 'types' })

    assert.deepStrictEqual(JSON.parse(query), { m: { a: 'number', b: 'string' } })
  })
})

describe('mongodb-core query sanitization (none mode)', () => {
  it('stringifies a top-level Buffer as "?" at every query extraction point', () => {
    const buffer = () => Buffer.alloc(64, 0x42)
    const cases = [
      { ops: { filter: buffer() }, name: 'find' },
      { ops: { pipeline: buffer() }, name: 'aggregate' },
      { ops: { deletes: [{ q: buffer(), limit: 1 }] }, name: 'delete' },
      { ops: { updates: [{ q: buffer(), u: { $set: { a: 1 } } }] }, name: 'update' },
    ]

    for (const { ops, name } of cases) {
      assert.strictEqual(callBindStart({ ns: 'db.coll', ops, name }), '"?"', `${name} did not redact the Buffer`)
    }
  })

  it('stringifies a nested Buffer as "?"', () => {
    const actual = callBindStart({ ns: 'db.coll', ops: { filter: { hash: Buffer.alloc(64, 0x42) } }, name: 'find' })

    assert.deepStrictEqual(JSON.parse(actual), { hash: '?' })
  })

  it('stringifies a deeply nested Buffer as "?"', () => {
    const actual = callBindStart({
      ns: 'db.coll',
      ops: { filter: { user: { metadata: { fingerprint: Buffer.alloc(64, 0x42) } } } },
      name: 'find',
    })

    assert.deepStrictEqual(JSON.parse(actual), { user: { metadata: { fingerprint: '?' } } })
  })

  it('stringifies buffers inside an array as "?"', () => {
    const actual = callBindStart({
      ns: 'db.coll',
      ops: { filter: { hashes: [Buffer.alloc(8, 0x41), Buffer.alloc(8, 0x42), Buffer.alloc(8, 0x43)] } },
      name: 'find',
    })

    assert.deepStrictEqual(JSON.parse(actual), { hashes: ['?', '?', '?'] })
  })

  it('stringifies a nested Buffer as "?" even when a sibling bigint forces the slow path', () => {
    // The bigint disqualifies canStringifyDirect, forcing the manual walker path that
    // production traffic hits whenever a command mixes primitives and BSON wrappers.
    const actual = callBindStart({
      ns: 'db.coll',
      ops: { filter: { hash: Buffer.alloc(64, 0x42), big: 9n } },
      name: 'find',
    })
    assert.deepStrictEqual(JSON.parse(actual), { hash: '?', big: '9' })
  })

  it('stringifies a top-level Uint8Array as "?"', () => {
    const actual = callBindStart({
      ns: 'db.coll',
      ops: { filter: new Uint8Array(64).fill(0xAB) },
      name: 'find',
    })

    assert.strictEqual(actual, '"?"')
  })

  it('stringifies a nested Uint8Array as "?" through the fast path', () => {
    const actual = callBindStart({
      ns: 'db.coll',
      ops: { filter: { photo: new Uint8Array(64).fill(0xAB) } },
      name: 'find',
    })

    assert.deepStrictEqual(JSON.parse(actual), { photo: '?' })
  })

  it('stringifies a nested Uint8Array as "?" through the slow path', () => {
    // The sibling bigint forces the manual walker rather than the fast path.
    const actual = callBindStart({
      ns: 'db.coll',
      ops: { filter: { photo: new Uint8Array(64).fill(0xAB), big: 9n } },
      name: 'find',
    })

    assert.deepStrictEqual(JSON.parse(actual), { photo: '?', big: '9' })
  })

  it('stringifies every TypedArray view shape as "?"', () => {
    const actual = callBindStart({
      ns: 'db.coll',
      ops: {
        filter: {
          u8: new Uint8Array(4),
          u8c: new Uint8ClampedArray(4),
          i8: new Int8Array(4),
          u16: new Uint16Array(4),
          i16: new Int16Array(4),
          u32: new Uint32Array(4),
          i32: new Int32Array(4),
          f32: new Float32Array(4),
          f64: new Float64Array(4),
          dv: new DataView(new ArrayBuffer(8)),
        },
      },
      name: 'find',
    })

    assert.deepStrictEqual(JSON.parse(actual), {
      u8: '?',
      u8c: '?',
      i8: '?',
      u16: '?',
      i16: '?',
      u32: '?',
      i32: '?',
      f32: '?',
      f64: '?',
      dv: '?',
    })
  })

  it('redacts a BigInt64Array without throwing inside JSON.stringify', () => {
    const actual = callBindStart({
      ns: 'db.coll',
      ops: { filter: { payload: new BigInt64Array(8).fill(1234567890123n) } },
      name: 'find',
    })

    assert.deepStrictEqual(JSON.parse(actual), { payload: '?' })
  })

  it('stringifies a zero-length Uint8Array as "?"', () => {
    const actual = callBindStart({
      ns: 'db.coll',
      ops: { filter: { empty: new Uint8Array(0) } },
      name: 'find',
    })

    assert.deepStrictEqual(JSON.parse(actual), { empty: '?' })
  })

  it('redacts a wrapper-class toJSON that exposes binary state at the top level and nested', () => {
    const state = new WeakMap()
    class BinaryQuery {
      constructor (data) { state.set(this, data) }
      toJSON () { return state.get(this) }
    }

    const topLevel = callBindStart({
      ns: 'db.coll',
      ops: { filter: new BinaryQuery(Buffer.alloc(64, 0x42)) },
      name: 'find',
    })
    assert.strictEqual(topLevel, '"?"')

    const nested = callBindStart({
      ns: 'db.coll',
      ops: { filter: { payload: new BinaryQuery(new Uint8Array(64).fill(0xAB)) } },
      name: 'find',
    })
    assert.deepStrictEqual(JSON.parse(nested), { payload: '?' })
  })

  it('does not invoke toJSON on a non-enumerable Buffer-wrapping property', () => {
    const carrier = {}
    Object.defineProperty(carrier, 'toJSON', {
      enumerable: false,
      value () { return Buffer.alloc(64, 0xAB) },
    })

    const actual = callBindStart({
      ns: 'db.coll',
      ops: { filter: carrier },
      name: 'find',
    })

    assert.strictEqual(actual, '"?"')
  })

  it('coerces a toJSON result of bigint to its decimal string', () => {
    const longLike = { _bsontype: 'Long', toJSON: () => 123n }
    const actual = callBindStart({
      ns: 'db.coll',
      ops: { filter: { count: longLike, big: 9n } },
      name: 'find',
    })

    assert.deepStrictEqual(JSON.parse(actual), { count: '123', big: '9' })
  })

  it('keeps a null toJSON result as null, matching JSON.stringify', () => {
    const invalidDate = new Date(NaN)
    assert.strictEqual(invalidDate.toJSON(), null)

    const object = callBindStart({
      ns: 'db.coll',
      ops: { filter: { expiresAt: invalidDate, big: 9n } },
      name: 'find',
    })
    assert.deepStrictEqual(JSON.parse(object), { expiresAt: null, big: '9' })

    const topLevel = callBindStart({ ns: 'db.coll', ops: { filter: invalidDate }, name: 'find' })
    assert.strictEqual(topLevel, 'null')

    const inArray = callBindStart({ ns: 'db.coll', ops: { filter: { at: [invalidDate, 1] } }, name: 'find' })
    assert.deepStrictEqual(JSON.parse(inArray), { at: [null, 1] })
  })

  it('renders a RegExp as its source and flags through the fast and slow paths', () => {
    const fast = callBindStart({ ns: 'db.coll', ops: { filter: { name: /^a$/i } }, name: 'find' })
    assert.deepStrictEqual(JSON.parse(fast), { name: { $regex: '^a$', $options: 'i' } })

    const slow = callBindStart({ ns: 'db.coll', ops: { filter: { name: /^a$/i, big: 9n } }, name: 'find' })
    assert.deepStrictEqual(JSON.parse(slow), { name: { $regex: '^a$', $options: 'i' }, big: '9' })
  })

  it('renders a Map as a document of its entries, matching the driver wire shape', () => {
    const fast = callBindStart({
      ns: 'db.coll',
      ops: { filter: { m: new Map([['a', 1], ['nested', { x: 2 }]]) } },
      name: 'find',
    })
    assert.deepStrictEqual(JSON.parse(fast), { m: { a: 1, nested: { x: 2 } } })

    const slow = callBindStart({
      ns: 'db.coll',
      ops: { filter: { m: new Map([['a', 1]]), big: 9n } },
      name: 'find',
    })
    assert.deepStrictEqual(JSON.parse(slow), { m: { a: 1 }, big: '9' })
  })

  it('renders an empty Map as an empty object', () => {
    const actual = callBindStart({ ns: 'db.coll', ops: { filter: { m: new Map() } }, name: 'find' })

    assert.deepStrictEqual(JSON.parse(actual), { m: {} })
  })

  it('renders a cross-realm RegExp by its source and flags', () => {
    const foreign = vm.runInNewContext('/^a$/i')
    const actual = callBindStart({ ns: 'db.coll', ops: { filter: { name: foreign } }, name: 'find' })

    assert.deepStrictEqual(JSON.parse(actual), { name: { $regex: '^a$', $options: 'i' } })
  })

  it('treats a plain object with a size property as a document, not a Map', () => {
    const actual = callBindStart({ ns: 'db.coll', ops: { filter: { size: 5, name: 'x' } }, name: 'find' })

    assert.deepStrictEqual(JSON.parse(actual), { size: 5, name: 'x' })
  })
})

describe('mongodb-core query obfuscation (array edge cases under redact)', () => {
  it('redacts every leaf uniformly, including functions and symbols', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: {
        query: {
          keep: 1,
          drop: () => {},
          sym: Symbol('x'),
          items: ['ok', () => {}, Symbol('x'), 'tail', null],
        },
      },
      name: 'find',
    }, { obfuscateQuery: 'redact' })

    assert.deepStrictEqual(JSON.parse(query), {
      keep: '?',
      drop: '?',
      sym: '?',
      items: ['?', '?', '?', '?', '?'],
    })
  })
})
