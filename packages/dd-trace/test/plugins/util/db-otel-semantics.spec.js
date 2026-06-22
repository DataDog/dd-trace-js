'use strict'

const assert = require('node:assert/strict')

const {
  applyDatabaseOtelSemantics,
  parseOperationName,
  parseCollectionName,
} = require('../../../src/plugins/util/db-otel-semantics')

describe('db-otel-semantics', () => {
  describe('parseOperationName', () => {
    it('reads the leading SQL keyword, upper-cased', () => {
      assert.strictEqual(parseOperationName('select * from demo where id = 1'), 'SELECT')
      assert.strictEqual(parseOperationName('insert into demo (id) values (1)'), 'INSERT')
      assert.strictEqual(parseOperationName('  UPDATE demo SET age = 2'), 'UPDATE')
      assert.strictEqual(parseOperationName('delete from demo where id = 2'), 'DELETE')
      assert.strictEqual(parseOperationName("call helloworld(1, 'x')"), 'CALL')
    })

    it('returns undefined when the leading token is not a known SQL command', () => {
      assert.strictEqual(parseOperationName('-- a comment'), undefined)
      assert.strictEqual(parseOperationName('wibble foo bar'), undefined)
      assert.strictEqual(parseOperationName(''), undefined)
    })
  })

  describe('parseCollectionName', () => {
    it('extracts the primary table for single-collection statements', () => {
      assert.strictEqual(parseCollectionName('select * from demo where id = 1', 'SELECT'), 'demo')
      assert.strictEqual(parseCollectionName('insert into demo (id) values (1)', 'INSERT'), 'demo')
      assert.strictEqual(parseCollectionName('update demo set age = 2', 'UPDATE'), 'demo')
      assert.strictEqual(parseCollectionName('delete from demo where id = 2', 'DELETE'), 'demo')
    })

    it('returns undefined when the table is not readily available', () => {
      assert.strictEqual(parseCollectionName("call helloworld(1, 'x')", 'CALL'), undefined)
      assert.strictEqual(parseCollectionName('select 1', 'SELECT'), undefined)
    })
  })

  describe('applyDatabaseOtelSemantics', () => {
    const run = (meta, metrics = {}, resource) => {
      const span = { meta, metrics, resource }
      applyDatabaseOtelSemantics(span)
      return span
    }

    it('renames the Datadog DB tags to OTel names and drops the legacy ones', () => {
      const span = run(
        { 'db.type': 'postgres', 'db.name': 'shop', 'db.user': 'admin', 'out.host': 'pg-host' },
        { 'network.destination.port': 5433, 'db.pid': 42 },
        'SELECT * FROM users WHERE id = 1'
      )

      assert.strictEqual(span.meta['db.system.name'], 'postgresql')
      assert.strictEqual(span.meta['db.namespace'], 'shop')
      assert.strictEqual(span.meta['server.address'], 'pg-host')
      assert.strictEqual(span.metrics['server.port'], 5433)
      assert.strictEqual(span.meta['db.query.text'], 'SELECT * FROM users WHERE id = 1')
      assert.strictEqual(span.meta['db.operation.name'], 'SELECT')
      assert.strictEqual(span.meta['db.collection.name'], 'users')

      // legacy Datadog names are gone (mutually exclusive)
      assert.strictEqual(span.meta['db.type'], undefined)
      assert.strictEqual(span.meta['db.name'], undefined)
      assert.strictEqual(span.meta['out.host'], undefined)
      assert.strictEqual(span.metrics['network.destination.port'], undefined)

      // Datadog-only attributes with no OTel equivalent are preserved
      assert.strictEqual(span.meta['db.user'], 'admin')
      assert.strictEqual(span.metrics['db.pid'], 42)
    })

    it('maps each known db.type to its stable db.system.name', () => {
      assert.strictEqual(run({ 'db.type': 'mysql' }).meta['db.system.name'], 'mysql')
      const mssql = run({ 'db.type': 'mssql', 'db.instance': 'inst' })
      assert.strictEqual(mssql.meta['db.system.name'], 'microsoft.sql_server')
      assert.strictEqual(mssql.meta['db.namespace'], 'inst')
      // an unmapped value passes through unchanged
      assert.strictEqual(run({ 'db.type': 'cassandra' }).meta['db.system.name'], 'cassandra')
    })

    it('is a no-op for spans without a db.type tag', () => {
      const span = run({ 'http.method': 'GET' }, {}, 'GET /')
      assert.strictEqual(span.meta['db.system.name'], undefined)
      assert.strictEqual(span.meta['http.method'], 'GET')
    })

    it('omits db.collection.name when the table is not parseable', () => {
      const span = run({ 'db.type': 'postgres' }, {}, "CALL helloworld(1, 'x')")
      assert.strictEqual(span.meta['db.operation.name'], 'CALL')
      assert.strictEqual(span.meta['db.collection.name'], undefined)
    })
  })
})
