'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')

const { storage } = require('../../datadog-core')
const agent = require('../../dd-trace/test/plugins/agent')
const { withNamingSchema } = require('../../dd-trace/test/setup/mocha')

describe('azure-cosmos pipeline', () => {
  const channel = dc.tracingChannel('orchestrion:@azure/cosmos:executePlugins')
  const legacyStorage = storage('legacy')

  before(async () => {
    await agent.load('azure-cosmos', {}, { spanComputePeerService: true })
    dc.channel('dd-trace:instrumentation:load').publish({ name: '@azure/cosmos' })
  })

  after(() => agent.close())

  describe('resource', () => {
    const cases = [
      {
        name: 'replaces document id with ? while preserving db and container names',
        requestContext: {
          operationType: 'delete',
          path: '/dbs/myDb/colls/myContainer/docs/test-id',
        },
        expected: 'delete /dbs/myDb/colls/myContainer/docs/?',
      },
      {
        name: 'replaces high-cardinality segments after resource types other than dbs or colls',
        requestContext: {
          operationType: 'execute',
          path: '/dbs/myDb/colls/myContainer/sprocs/myStoredProc',
        },
        expected: 'execute /dbs/myDb/colls/myContainer/sprocs/?',
      },
      {
        name: 'does not modify path when there is no id segment after docs',
        requestContext: {
          operationType: 'query',
          path: '/dbs/myDb/colls/myContainer/docs',
        },
        expected: 'query /dbs/myDb/colls/myContainer/docs',
      },
      {
        name: 'does not modify path when only database and container segments exist',
        requestContext: {
          operationType: 'read',
          path: '/dbs/myDb/colls/myContainer',
        },
        expected: 'read /dbs/myDb/colls/myContainer',
      },
    ]

    for (const { name, requestContext, expected } of cases) {
      it(name, async () => {
        const assertion = agent.assertFirstTraceSpan(span => {
          assert.strictEqual(span.resource, expected)
          assert.strictEqual(span.service, 'test-azure-cosmos')
          assert.strictEqual(span.meta['_dd.svc_src'], 'azure-cosmos')
          assert.strictEqual(span.meta['peer.service'], 'myDb')
          assert.strictEqual(span.meta['_dd.peer.service.source'], 'db.name')
        })

        await Promise.all([
          assertion,
          channel.tracePromise(
            () => Promise.resolve({ code: 200 }),
            { arguments: [undefined, requestContext, undefined, 'operation'] }
          ),
        ])
      })
    }
  })

  it('adds response fields on success', async () => {
    const assertion = agent.assertFirstTraceSpan(span => {
      assert.strictEqual(span.meta['db.response.status_code'], '201')
      assert.strictEqual(span.metrics['cosmosdb.response.sub_status_code'], 1000)
    })
    const requestContext = {
      operationType: 'create',
      resourceType: 'docs',
      path: '/dbs/myDb/colls/myContainer/docs',
    }

    await Promise.all([
      assertion,
      channel.tracePromise(
        () => Promise.resolve({ code: 201, substatus: 1000 }),
        { arguments: [undefined, requestContext, undefined, 'operation'] }
      ),
    ])
  })

  it('uses the request body for a created database name', async () => {
    const assertion = agent.assertFirstTraceSpan(span => {
      assert.strictEqual(span.resource, 'create /dbs')
      assert.strictEqual(span.meta['db.name'], 'newDatabase')
      assert.strictEqual(span.meta['peer.service'], 'newDatabase')
      assert.strictEqual(span.meta['cosmosdb.container'], undefined)
    })
    const requestContext = {
      operationType: 'create',
      resourceType: 'dbs',
      path: '/dbs',
      body: { id: 'newDatabase' },
    }

    await Promise.all([
      assertion,
      channel.tracePromise(
        () => Promise.resolve({ code: 201 }),
        { arguments: [undefined, requestContext, undefined, 'operation'] }
      ),
    ])
  })

  it('traces request-level reads on documents', async () => {
    const assertion = agent.assertFirstTraceSpan({
      resource: 'read /dbs/myDb/colls/myContainer/docs/?',
    })
    const requestContext = {
      operationType: 'read',
      resourceType: 'docs',
      path: '/dbs/myDb/colls/myContainer/docs/item-id',
    }

    await Promise.all([
      assertion,
      channel.tracePromise(
        () => Promise.resolve({ code: 200 }),
        { arguments: [undefined, requestContext, undefined, 'request'] }
      ),
    ])
  })

  it('adds response fields and error tags on failure', async () => {
    const error = Object.assign(new Error('request failed'), { code: 409, substatus: 1001 })
    const assertion = agent.assertFirstTraceSpan(span => {
      assert.strictEqual(span.error, 1)
      assert.strictEqual(span.meta['error.message'], error.message)
      assert.strictEqual(span.meta['db.response.status_code'], '409')
      assert.strictEqual(span.metrics['cosmosdb.response.sub_status_code'], 1001)
    })
    const requestContext = {
      operationType: 'create',
      resourceType: 'docs',
      path: '/dbs/myDb/colls/myContainer/docs',
    }

    const resultPromise = channel.tracePromise(
      () => Promise.reject(error),
      { arguments: [undefined, requestContext, undefined, 'operation'] }
    )
    await Promise.all([assertion, assert.rejects(resultPromise, error)])
  })

  it('inherits the active store for duplicate request-level hooks', async () => {
    const parentStore = { marker: 'parent' }
    const requestContext = {
      operationType: 'create',
      resourceType: 'docs',
      path: '/dbs/myDb/colls/myContainer/docs',
    }
    const noTraces = agent.assertNoTraces(() => {
      throw new Error('duplicate request-level hook unexpectedly produced a trace')
    }, { timeoutMs: 100 })

    await legacyStorage.run(parentStore, () => channel.tracePromise(() => {
      assert.strictEqual(legacyStorage.getStore(), parentStore)
      return Promise.resolve({ code: 201 })
    }, { arguments: [undefined, requestContext, undefined, 'request'] }))

    await noTraces
  })

  it('binds a no-op store for empty-path account reads', async () => {
    const parentStore = { marker: 'parent' }
    const requestContext = {
      operationType: 'read',
      resourceType: 'none',
      path: '',
    }
    const noTraces = agent.assertNoTraces(() => {
      throw new Error('empty-path read unexpectedly produced a trace')
    }, { timeoutMs: 100 })

    await legacyStorage.run(parentStore, () => channel.tracePromise(() => {
      assert.deepStrictEqual(legacyStorage.getStore(), { noop: true })
      return Promise.resolve({ code: 200 })
    }, { arguments: [undefined, requestContext, undefined, 'operation'] }))

    await noTraces
  })

  withNamingSchema(
    () => channel.tracePromise(
      () => Promise.resolve({ code: 200 }),
      {
        arguments: [undefined, {
          operationType: 'read',
          resourceType: 'docs',
          path: '/dbs/myDb/colls/myContainer/docs/item-id',
        }, undefined, 'operation'],
      }
    ),
    {
      v0: {
        opName: 'cosmosdb.query',
        serviceName: 'test-azure-cosmos',
      },
      v1: {
        opName: 'cosmosdb.query',
        serviceName: 'test',
      },
    }
  )

  describe('with a configured service', () => {
    before(() => agent.reload('azure-cosmos', { service: 'custom-cosmos' }))

    it('resolves the service and its source through the naming schema', async () => {
      const assertion = agent.assertFirstTraceSpan(span => {
        assert.strictEqual(span.service, 'custom-cosmos')
        assert.strictEqual(span.meta['_dd.svc_src'], 'opt.plugin')
      })
      const requestContext = {
        operationType: 'read',
        resourceType: 'docs',
        path: '/dbs/myDb/colls/myContainer/docs/item-id',
      }

      await Promise.all([
        assertion,
        channel.tracePromise(
          () => Promise.resolve({ code: 200 }),
          { arguments: [undefined, requestContext, undefined, 'operation'] }
        ),
      ])
    })
  })
})
