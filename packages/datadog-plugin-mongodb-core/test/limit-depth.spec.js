'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const sinon = require('sinon')

const MongodbCorePlugin = require('../src/index')

// `limitDepth` is module-private; exercise it through `bindStart`, the only
// caller that observably surfaces its output (as `meta['mongodb.query']`).
function callBindStart (ctx) {
  const startSpan = sinon.stub().returns({ finish () {} })
  const self = {
    config: { heartbeatEnabled: true, queryInResourceName: false },
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
