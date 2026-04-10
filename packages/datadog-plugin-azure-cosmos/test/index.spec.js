'use strict'

const assert = require('node:assert/strict')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { ANY_STRING } = require('../../../integration-tests/helpers')
const { setup, teardown } = require('./cosmos-helpers')

describe('Plugin', () => {
  describe('azure-cosmos', () => {
    withVersions('azure-cosmos', '@azure/cosmos', (version) => {
      let myLib
      let client
      let database
      let container

      beforeEach(async () => {
        ({ client, database, container } = await setup())
        return agent.load('azure-cosmos')
      })

      afterEach(async () => {
        await teardown(client, database)
        return agent.close({ ritmReset: false })
      })

      it('should create a span', async () => {
        // Object-based assertion (preferred) — uses assertObjectContains internally
        const expectedSpanPromise = agent.assertFirstTraceSpan({
          name: 'cosmosdb.query',
          service: 'test',
          type: 'cosmosdb',
          resource: 'create /dbs/testDatabase/colls/testContainer/docs',
          meta: {
            component: 'azure_cosmos',
            'db.system': 'cosmosdb',
            'db.instance': 'testDatabase',
            'cosmosdb.container': 'testContainer',
            'cosmosdb.connection.mode': 'gateway',
            'http.useragent': 'test',
            'out.host': 'localhost',
            'span.kind': 'client',
          },
        })

        // trigger the instrumented operation
        container.items.create({ id: 'item1', productName: 'Test Product', productModel: 'Model 1' })


        await expectedSpanPromise
      })

      /*it('should create spans with callback assertion', async () => {

        const expectedResources = ['upsert /dbs/testDatabase/colls/testContainer/docs', 'read /dbs/testDatabase/colls/testContainer/docs', 'query /dbs/testDatabase/colls/testContainer/docs', 'delete /dbs/testDatabase/colls/testContainer/docs/item1']
        // Callback-based assertion — for complex multi-span assertions
        const expectedSpanPromise = agent.assertSomeTraces(traces => {
          const allSpans = traces.flat()
          assert.strictEqual(allSpans.length, 4)

          for (let i = 0; i <= 3; i++) {
            var span = allSpans[i]
            assert.strictEqual(span.name, 'cosmosdb.query')
            assert.strictEqual(span.service, 'test')
            assert.strictEqual(span.type, 'cosmosdb')
            assert.strictEqual(span.resource, expectedResources[i])
            assert.strictEqual(span.meta.component, 'azure_cosmos')
            assert.strictEqual(span.meta['db.system'], 'cosmosdb')
            assert.strictEqual(span.meta['db.instance'], 'testDatabase')
            assert.strictEqual(span.meta['cosmosdb.container'], 'testContainer')
            assert.strictEqual(span.meta['cosmosdb.connection.mode'], 'gateway')


            assert(span.meta['http.useragent'].includes('azure-cosmos-js/'))
            assert(parseInt(http.status_code) >= 200 && parseInt(http.status_code) < 300)
          }
        })

        container.items.upsert({ id: 'item1', productName: 'Test Product', productModel: 'Model 1' })

        const deleteQuery = {
          query: 'SELECT * FROM testContainer p WHERE p.productModel = "Model 1"',
        };
        const { resources: toDelete } = await container.items
          .query(deleteQuery, { enableCrossPartitionQuery: true })
          .fetchAll();
        for (const item of toDelete) {
          await container.item(item.id, 'Test Product').delete();
        }

        await expectedSpanPromise
      })

      it('should create spans if an error occurs', async () => {
        // Callback-based assertion — for complex multi-span assertions
        const expectedSpanPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][1]
          assert.strictEqual(span.name, 'cosmosdb.query')
          assert.strictEqual(span.service, 'test')
          assert.strictEqual(span.type, 'cosmosdb')
          assert.strictEqual(span.resource, 'create /dbs/testDatabase/colls/testContainer/docs')
          assert.strictEqual(span.meta.component, 'azure_cosmos')
          assert.strictEqual(span.meta['db.system'], 'cosmosdb')
          assert.strictEqual(span.meta['db.instance'], 'testDatabase')
          assert.strictEqual(span.meta['cosmosdb.container'], 'testContainer')
          assert.strictEqual(span.meta['cosmosdb.connection.mode'], 'gateway')
          assert.strictEqual(span.error, 1)
          assert.strictEqual(span.meta['error.message'], 'The document already exists in the collection.')
          assert.strictEqual(span.meta['error.type'], 'Error')
          assert.strictEqual(span.meta['http.status_code'], '409')

          assert(span.meta['http.useragent'].includes('azure-cosmos-js/'))
        })


        container.items.upsert({ id: 'item1', productName: 'Test Product', productModel: 'Model 1' })

        // trigger the instrumented operation with an error
        container.items.create({ id: 'item1', productName: 'Test Product', productModel: 'Model 1' })

        await expectedSpanPromise
      })*/
    })
  })
})
