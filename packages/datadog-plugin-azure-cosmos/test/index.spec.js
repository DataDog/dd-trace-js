'use strict'

const assert = require('node:assert/strict')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const { setup, teardown } = require('./cosmos-helpers')

describe('Plugin', () => {
  describe('azure-cosmos', () => {
    withVersions('azure-cosmos', '@azure/cosmos', (version) => {
      let client
      let container

      beforeEach(async () => {
        // Provision DB/container without emitting azure-cosmos spans (plugin subscriptions stay off).
        await agent.load('azure-cosmos', { enabled: false })
        ; ({ client, container } = await setup())
        agent.reload('azure-cosmos', { enabled: true })
      })

      afterEach(async () => {
        await teardown(client)
        return agent.close({ ritmReset: false })
      })

      it('should create a span', async () => {
        const expectedSpanPromise = agent.assertFirstTraceSpan({
          name: 'cosmosdb.query',
          service: 'test-azure-cosmos',
          type: 'cosmosdb',
          resource: 'create /dbs/testDatabase/colls/testContainer/docs',
          meta: {
            component: 'azure_cosmos',
            'db.system': 'cosmosdb',
            'db.name': 'testDatabase',
            'cosmosdb.container': 'testContainer',
            'cosmosdb.connection.mode': 'gateway',
            'span.kind': 'client',
          },
        })

        await container.items.create({
          id: 'item1',
          productName: 'Test Product',
          productModel: 'Model 1',
        })

        await expectedSpanPromise
      })

      it('should create spans with callback assertion', async () => {
        const expectedResources = ['upsert /dbs/testDatabase/colls/testContainer/docs',
          'read /dbs/testDatabase/colls/testContainer/docs',
          'query /dbs/testDatabase/colls/testContainer/docs',
          'delete /dbs/testDatabase/colls/testContainer/docs/item1']
        // Callback-based assertion — for complex multi-span assertions
        const expectedSpanPromise = agent.assertSomeTraces(traces => {
          const span = traces[0][0]

          assertObjectContains(span, {
            name: 'cosmosdb.query',
            service: 'test-azure-cosmos',
            type: 'cosmosdb',
            meta: {
              component: 'azure_cosmos',
              'db.system': 'cosmosdb',
              'db.name': 'testDatabase',
              'cosmosdb.container': 'testContainer',
              'cosmosdb.connection.mode': 'gateway',
            },
          })

          assert(expectedResources.includes(span.resource))

          assert(span.meta['http.useragent'].includes('azure-cosmos-js/'))
          assert(parseInt(span.meta['http.status_code']) >= 200 && parseInt(span.meta['http.status_code']) < 300)
        })

        container.items.upsert({ id: 'item1', productName: 'Test Product', productModel: 'Model 1' })

        const deleteQuery = {
          query: 'SELECT * FROM testContainer p WHERE p.productModel = "Model 1"',
        }
        const { resources: toDelete } = await container.items
          .query(deleteQuery, { enableCrossPartitionQuery: true })
          .fetchAll()
        for (const item of toDelete) {
          await container.item(item.id, 'Test Product').delete()
        }

        await expectedSpanPromise
      })

      it('should create spans if an error occurs', async () => {
        const expectedSpanPromise = agent.assertSomeTraces(
          traces => {
            const allSpans = traces.filter(Array.isArray).flat()

            const conflictCreate = allSpans.find(
              s =>
                s?.resource === 'create /dbs/testDatabase/colls/testContainer/docs' &&
                s?.meta?.['http.status_code'] === '409'
            )
            assert.ok(
              conflictCreate,
              'expected 409 create span in payload'
            )

            assertObjectContains(conflictCreate, {
              name: 'cosmosdb.query',
              service: 'test-azure-cosmos',
              type: 'cosmosdb',
              resource: 'create /dbs/testDatabase/colls/testContainer/docs',
              error: 1,
              meta: {
                component: 'azure_cosmos',
                'db.system': 'cosmosdb',
                'db.name': 'testDatabase',
                'cosmosdb.container': 'testContainer',
                'cosmosdb.connection.mode': 'gateway',
                'error.message': 'The document already exists in the collection.',
                'error.type': 'Error',
                'http.status_code': '409',
              },
            })

            assert(conflictCreate.meta['http.useragent'].includes('azure-cosmos-js/'))
          }
        )

        await container.items.upsert({ id: 'item1', productName: 'Test Product', productModel: 'Model 1' })
        void container.items.create({ id: 'item1', productName: 'Test Product', productModel: 'Model 1' })
          .catch(() => { })

        await expectedSpanPromise
      })
    })
  })
})
