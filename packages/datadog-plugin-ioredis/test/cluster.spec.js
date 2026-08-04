'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')

const { after, before, describe, it } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')
const { withNamingSchema, withVersions } = require('../../dd-trace/test/setup/mocha')
const { expectedSchema, rawExpectedSchema } = require('./naming')

// grokzen/redis-cluster announces nodes on 127.0.0.1:7000-7005.
const CLUSTER_NODES = [{ host: '127.0.0.1', port: 7000 }]

describe('Plugin', () => {
  let Redis
  let cluster
  let tracer

  describe('ioredis (cluster)', () => {
    withVersions('ioredis', 'ioredis', version => {
      before(async () => {
        await agent.load(['ioredis'])
        tracer = require('../../dd-trace')
        Redis = require(`../../../versions/ioredis@${version}`).get()
        cluster = new Redis.Cluster(CLUSTER_NODES)
        // Keep transient node errors from crashing the run as unhandled.
        cluster.on('error', () => {})
        await once(cluster, 'ready')
      })

      after(async () => {
        await cluster.quit()
        await agent.close()
      })

      it('traces commands the cluster dispatches to a node', async () => {
        const assertion = agent.assertFirstTraceSpan({
          name: expectedSchema.outbound.opName,
          service: expectedSchema.outbound.serviceName,
          resource: 'get',
          type: 'redis',
          meta: {
            component: 'ioredis',
            'db.type': 'redis',
            'span.kind': 'client',
            'redis.raw_command': 'GET cluster-key',
          },
        }, { spanResourceMatch: /^get$/ })

        await cluster.get('cluster-key')

        await assertion
      })

      it('tags the span with the resolved shard endpoint', async () => {
        const assertion = agent.assertSomeTraces(traces => {
          const span = traces[0].find(span => span.resource === 'set')
          assert.ok(span, 'expected a span for the set command')
          const port = span.metrics['network.destination.port']
          assert.ok(port >= 7000 && port <= 7005, `expected a cluster shard port, got ${port}`)
        }, { spanResourceMatch: /^set$/ })

        await cluster.set('cluster-key', 'cluster-value')

        await assertion
      })

      it('runs the command in the active parent context', async () => {
        const parent = tracer.startSpan('test')

        const assertion = agent.assertSomeTraces(traces => {
          const span = traces[0].find(span => span.resource === 'get')
          assert.ok(span, 'expected a span for the get command')
          assert.strictEqual(span.parent_id.toString(), parent.context().toSpanId())
        }, { spanResourceMatch: /^get$/ })

        await tracer.scope().activate(parent, async () => {
          await cluster.get('cluster-key')
          assert.strictEqual(tracer.scope().active(), parent)
        })
        parent.finish()

        await assertion
      })

      withNamingSchema(
        () => cluster.get('cluster-key'),
        rawExpectedSchema.outbound
      )
    })
  })
})
