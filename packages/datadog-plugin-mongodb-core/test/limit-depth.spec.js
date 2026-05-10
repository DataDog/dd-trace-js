'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const sinon = require('sinon')

const MongodbCorePlugin = require('../src/index')

// `limitDepth` is module-private; exercise it through `bindStart`, the only
// caller that observably surfaces its output (as `meta['mongodb.query']`).
function callBindStart (ctx, configOverride) {
  const startSpan = sinon.stub().returns({ finish () {} })
  const self = {
    config: {
      heartbeatEnabled: true,
      queryInResourceName: false,
      obfuscateQuery: false,
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

  it('renders Binary BSON values as "?"', () => {
    const binary = { _bsontype: 'Binary', buffer: Buffer.from('payload') }
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { blob: binary } },
      name: 'find',
    })

    assert.deepStrictEqual(JSON.parse(query), { blob: '?' })
  })
})

describe('mongodb-core query obfuscation', () => {
  it('replaces primitive leaves with "?" when obfuscateQuery is enabled', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { user: 'alice', age: 30, active: true } },
      name: 'find',
    }, { obfuscateQuery: true })

    assert.deepStrictEqual(JSON.parse(query), { user: '?', age: '?', active: '?' })
  })

  it('replaces null leaves with "?" when obfuscateQuery is enabled', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { deleted: null, age: 0, name: '' } },
      name: 'find',
    }, { obfuscateQuery: true })

    assert.deepStrictEqual(JSON.parse(query), { deleted: '?', age: '?', name: '?' })
  })

  it('preserves operator keys but obfuscates their values', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { age: { $gte: 18, $lte: 65 }, status: { $in: ['active', 'pending'] } } },
      name: 'find',
    }, { obfuscateQuery: true })

    assert.deepStrictEqual(JSON.parse(query), {
      age: { $gte: '?', $lte: '?' },
      status: { $in: ['?', '?'] },
    })
  })

  it('coerces bigint leaves to "?" when obfuscateQuery is enabled', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { _id: 9999999999999999999999n } },
      name: 'find',
    }, { obfuscateQuery: true })

    assert.deepStrictEqual(JSON.parse(query), { _id: '?' })
  })

  it('obfuscates toJSON-flattened BSON values (ObjectId-shaped) as "?"', () => {
    const objectId = { _bsontype: 'ObjectId', toJSON: () => '123456781234567812345678' }
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { _id: objectId } },
      name: 'find',
    }, { obfuscateQuery: true })

    assert.deepStrictEqual(JSON.parse(query), { _id: '?' })
  })

  it('still renders Binary BSON values as "?" with obfuscateQuery enabled', () => {
    const binary = { _bsontype: 'Binary', buffer: Buffer.from('payload') }
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { blob: binary } },
      name: 'find',
    }, { obfuscateQuery: true })

    assert.deepStrictEqual(JSON.parse(query), { blob: '?' })
  })

  it('preserves pipeline operator shapes while obfuscating leaves', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: {
        pipeline: [
          { $match: { user: 'alice', age: { $gte: 18 } } },
          { $count: 'total' },
        ],
      },
      name: 'aggregate',
    }, { obfuscateQuery: true })

    assert.deepStrictEqual(JSON.parse(query), [
      { $match: { user: '?', age: { $gte: '?' } } },
      { $count: '?' },
    ])
  })

  it('obfuscates each q across multi-statement updates', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: {
        updates: [
          { q: { user: 'alice' }, u: { $set: { a: 1 } } },
          { q: { user: 'bob' }, u: { $set: { b: 2 } } },
        ],
      },
      name: 'update',
    }, { obfuscateQuery: true })

    assert.deepStrictEqual(JSON.parse(query), [
      { user: '?' },
      { user: '?' },
    ])
  })

  it('keeps verbatim values when obfuscateQuery is false (regression for default off)', () => {
    const query = callBindStart({
      ns: 'db.coll',
      ops: { query: { user: 'alice', age: 30 } },
      name: 'find',
    }, { obfuscateQuery: false })

    assert.deepStrictEqual(JSON.parse(query), { user: 'alice', age: 30 })
  })
})
