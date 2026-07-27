'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProcAndExpectExit,
  varySandbox,
  stopProc,
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
      await stopProc(proc)
      await agent.stop()
    })

    const queueImportOptions = {
      bindingName: 'bullmq',
      packageName: 'bullmq',
      defaultExport: true,
      namedExports: ['Queue'],
      namedExportBinding: 'namespace',
    }

    describe('Queue.add()', () => {
      const variants = varySandbox('server-queue-add.mjs', queueImportOptions)

      for (const variant of Object.keys(variants)) {
        it(`is instrumented ${variant}`, async () => {
          const res = agent.assertMessageReceived(({ headers, payload }) => {
            assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
            assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
            assert.strictEqual(checkSpansForServiceName(payload, 'bullmq.add'), true)
          })

          proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), variants[variant], agent.port)

          await res
        }).timeout(60000)
      }
    })

    describe('Queue.addBulk()', () => {
      const variants = varySandbox('server-queue-add-bulk.mjs', queueImportOptions)

      for (const variant of Object.keys(variants)) {
        it(`is instrumented ${variant}`, async () => {
          const res = agent.assertMessageReceived(({ headers, payload }) => {
            assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
            assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
            assert.strictEqual(checkSpansForServiceName(payload, 'bullmq.addBulk'), true)
          })

          proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), variants[variant], agent.port)

          await res
        }).timeout(60000)
      }
    })

    describe('FlowProducer.add()', () => {
      const variants = varySandbox('server-flow-producer-add.mjs', {
        bindingName: 'bullmq',
        packageName: 'bullmq',
        defaultExport: true,
        namedExports: ['FlowProducer'],
        namedExportBinding: 'namespace',
      })

      for (const variant of Object.keys(variants)) {
        it(`is instrumented ${variant}`, async () => {
          const res = agent.assertMessageReceived(({ headers, payload }) => {
            assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
            assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
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
      const variants = varySandbox('server-worker-process-job.mjs', {
        bindingName: 'bullmq',
        packageName: 'bullmq',
        defaultExport: true,
        namedExports: ['Queue', 'Worker', 'QueueEvents'],
        namedExportBinding: 'namespace',
      })

      for (const variant of Object.keys(variants)) {
        it(`is instrumented ${variant}`, async () => {
          const res = agent.assertMessageReceived(({ headers, payload }) => {
            assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
            assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
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
