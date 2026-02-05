'use strict'

const assert = require('node:assert/strict')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProcAndExpectExit,
  varySandbox
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

describe('esm', () => {
  let agent
  let proc
  let variants

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
      beforeEach(async () => {
        variants = varySandbox('server-queue-add.mjs', 'bullmq', 'Queue')
      })

      for (const variant of varySandbox.VARIANTS) {
        it(`is instrumented ${variant}`, async () => {
          const res = agent.assertMessageReceived(({ headers, payload }) => {
            assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
            assert.ok(Array.isArray(payload))
            assert.strictEqual(checkSpansForServiceName(payload, 'bullmq.add'), true)
          })

          proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), variants[variant], agent.port)

          await res
        }).timeout(60000)
      }
    })

    describe('Queue.addBulk()', () => {
      beforeEach(async () => {
        variants = varySandbox('server-queue-add-bulk.mjs', 'bullmq', 'Queue')
      })

      for (const variant of varySandbox.VARIANTS) {
        it(`is instrumented ${variant}`, async () => {
          const res = agent.assertMessageReceived(({ headers, payload }) => {
            assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
            assert.ok(Array.isArray(payload))
            assert.strictEqual(checkSpansForServiceName(payload, 'bullmq.addBulk'), true)
          })

          proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), variants[variant], agent.port)

          await res
        }).timeout(60000)
      }
    })

    describe('FlowProducer.add()', () => {
      beforeEach(async () => {
        variants = varySandbox('server-flow-producer-add.mjs', 'bullmq', 'FlowProducer')
      })

      for (const variant of varySandbox.VARIANTS) {
        it(`is instrumented ${variant}`, async () => {
          const res = agent.assertMessageReceived(({ headers, payload }) => {
            assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
            assert.ok(Array.isArray(payload))
            assert.strictEqual(checkSpansForServiceName(payload, 'bullmq.add'), true)
          })

          proc = await spawnPluginIntegrationTestProcAndExpectExit(
            sandboxCwd(),
            variants[variant],
            agent.port
          )

          await res
        }).timeout(60000)
      }
    })

    describe('Worker.callProcessJob()', () => {
      beforeEach(async () => {
        variants = varySandbox('server-worker-process-job.mjs', 'bullmq', 'Queue, Worker, QueueEvents')
      })

      for (const variant of varySandbox.VARIANTS) {
        it(`is instrumented ${variant}`, async () => {
          const res = agent.assertMessageReceived(({ headers, payload }) => {
            assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
            assert.ok(Array.isArray(payload))
            assert.strictEqual(checkSpansForServiceName(payload, 'bullmq.processJob'), true)
          })

          proc = await spawnPluginIntegrationTestProcAndExpectExit(
            sandboxCwd(),
            variants[variant],
            agent.port,
            // Disable Redis/ioredis instrumentation to avoid hitting max active requests limit
            { DD_TRACE_REDIS_ENABLED: 'false', DD_TRACE_IOREDIS_ENABLED: 'false' }
          )

          await res
        }).timeout(60000)
      }
    })
  })
})
