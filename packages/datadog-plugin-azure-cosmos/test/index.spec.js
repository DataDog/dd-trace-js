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
        const expectedResources = [
          'upsert /dbs/testDatabase/colls/testContainer/docs',
          'read /dbs/testDatabase/colls/testContainer/docs',
          'query /dbs/testDatabase/colls/testContainer/docs',
          'delete /dbs/testDatabase/colls/testContainer/docs/?',
        ]

        const validatedResources = new Set()
        const expectedSpanPromise = agent.assertSomeTraces(
          traces => {
            const allSpans = traces.filter(Array.isArray).flat()
            for (const span of allSpans) {
              const resource = span?.resource
              if (!expectedResources.includes(resource) || validatedResources.has(resource)) continue

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

              assert(span.meta['http.useragent'].includes('azure-cosmos-js/'), 'expected http.useragent in span meta')
              assert(parseInt(span.meta['http.status_code']) >= 200 && parseInt(span.meta['http.status_code']) < 300)

              validatedResources.add(resource)
            }

            const missing = expectedResources.filter(r => !validatedResources.has(r))
            assert.strictEqual(
              missing.length,
              0,
              `still waiting for spans: ${missing.join(', ')}; validated: ${[...validatedResources].join(', ')}`
            )
          }
        )

        await container.items.upsert({ id: 'item1', productName: 'Test Product', productModel: 'Model 1' })

        await container.items
          .query(
            { query: 'SELECT * FROM testContainer p WHERE p.productModel = "Model 1"' },
            { enableCrossPartitionQuery: true }
          )
          .fetchAll()

        await container.item('item1', 'Test Product').delete()

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
