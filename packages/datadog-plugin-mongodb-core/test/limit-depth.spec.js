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
})
