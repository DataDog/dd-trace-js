'use strict'

const assert = require('node:assert/strict')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProcAndExpectExit,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

describe('esm', () => {
  let agent
  let proc

  withVersions('bullmq', 'bullmq', '>=5.66.0', version => {
    useSandbox([`'bullmq@${version}'`], false, [
      './packages/datadog-plugin-bullmq/test/integration-test/*'])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })

    describe('Queue.add()', () => {
      it('is instrumented', async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload))
          assert.strictEqual(checkSpansForServiceName(payload, 'bullmq.add'), true)
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), 'server-queue-add.mjs', agent.port)

        await res
      }).timeout(60000)
    })

    describe('Queue.addBulk()', () => {
      it('is instrumented', async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload))
          assert.strictEqual(checkSpansForServiceName(payload, 'bullmq.addBulk'), true)
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), 'server-queue-add-bulk.mjs', agent.port)

        await res
      }).timeout(60000)
    })

    describe('FlowProducer.add()', () => {
      it('is instrumented', async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload))
          assert.strictEqual(checkSpansForServiceName(payload, 'bullmq.add'), true)
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(
          sandboxCwd(),
          'server-flow-producer-add.mjs',
          agent.port
        )

        await res
      }).timeout(60000)
    })

    describe('Worker.callProcessJob()', () => {
      it('is instrumented', async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload))
          assert.strictEqual(checkSpansForServiceName(payload, 'bullmq.processJob'), true)
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(
          sandboxCwd(),
          'server-worker-process-job.mjs',
          agent.port,
          // Disable Redis/ioredis instrumentation to avoid hitting max active requests limit
          { DD_TRACE_REDIS_ENABLED: 'false', DD_TRACE_IOREDIS_ENABLED: 'false' }
        )

        await res
      }).timeout(60000)
    })
  })
})
