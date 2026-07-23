'use strict'

const assert = require('node:assert/strict')

const { afterEach, describe, it } = require('mocha')

require('../setup/core')

const { storage } = require('../../../datadog-core')
const { createLifecycleChannels } = require('../../src/events/lifecycle')
const { getOrchestrionChannel, runSemanticStart } = require('../../src/events/orchestrion')

const legacyStorage = storage('legacy')

describe('Orchestrion event source', () => {
  const bindings = []

  afterEach(() => {
    for (const channel of bindings) channel.unbindStore(legacyStorage)
    bindings.length = 0
    legacyStorage.enterWith(undefined)
  })

  it('resolves the tracing channel emitted by an Orchestrion transform', () => {
    const channel = getOrchestrionChannel('mysql', 'Connection_query')

    assert.strictEqual(channel.start.name, 'tracing:orchestrion:mysql:Connection_query:start')
    assert.strictEqual(channel.end.name, 'tracing:orchestrion:mysql:Connection_query:end')
    assert.strictEqual(channel.error.name, 'tracing:orchestrion:mysql:Connection_query:error')
  })

  it('keeps physical source channels package-scoped', () => {
    const mysql = getOrchestrionChannel('mysql', 'db_query')
    const mysqlAgain = getOrchestrionChannel('mysql', 'db_query')
    const mariadb = getOrchestrionChannel('mariadb', 'db_query')

    assert.strictEqual(mysql.start, mysqlAgain.start)
    assert.notStrictEqual(mysql.start, mariadb.start)
    assert.strictEqual(mysql.start.name, 'tracing:orchestrion:mysql:db_query:start')
    assert.strictEqual(mariadb.start.name, 'tracing:orchestrion:mariadb:db_query:start')
  })

  it('carries the transform context and semantic store through the source start channel', () => {
    const source = getOrchestrionChannel('mysql', 'Connection_query')
    const semantic = createLifecycleChannels('tracing:datadog:db:query', ['start'])
    const queryStore = { span: {} }
    const context = { arguments: ['SELECT 1'] }
    let activeStore
    let receivedContext

    semantic.start.bindStore(legacyStorage, event => {
      receivedContext = event
      return queryStore
    })
    source.start.bindStore(legacyStorage, event => runSemanticStart(event, semantic.start, normalizeMysql))
    bindings.push(semantic.start, source.start)

    source.start.runStores(context, () => {
      activeStore = legacyStorage.getStore()
    })

    assert.strictEqual(receivedContext, context)
    assert.strictEqual(activeStore, queryStore)
    assert.strictEqual(context.source, 'mysql')
    assert.strictEqual(context.operation, 'db.query')
  })
})

function normalizeMysql (context) {
  context.source = 'mysql'
  context.operation = 'db.query'
  return context
}
