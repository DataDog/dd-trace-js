'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const sinon = require('sinon')

const MongodbCorePlugin = require('../src/index')

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
    // The bigint forces the slow none path; MinKey has no toJSON so the replacer
    // sees `value === original` and falls into the BSON sentinel branch.
    const minKey = { _bsontype: 'MinKey' }
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { boundary: minKey, drop: () => {}, big: 9n } },
      name: 'find',
    })

    assert.deepStrictEqual(JSON.parse(query), { boundary: '?', big: '9' })
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
