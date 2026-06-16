'use strict'

/* eslint-disable no-console */

// Minimal AWS durable-execution app, run via the SDK's local test runner (no AWS infra)
// and bundled with esbuild. The traced build keeps the SDK external so Orchestrion can
// rewrite it at load time — esbuild inlines source without that rewriting.

require('dd-trace').init({ flushInterval: 0 })

const { LocalDurableTestRunner } = require('@aws/durable-execution-sdk-js-testing')
const { withDurableExecution } = require('@aws/durable-execution-sdk-js')

async function main () {
  await LocalDurableTestRunner.setupTestEnvironment()

  const handlerFunction = withDurableExecution(async (event, ctx) => {
    await ctx.step('verify-step', async () => {})
  })

  const runner = new LocalDurableTestRunner({ handlerFunction })
  await runner.run({ payload: { testInput: true } })

  await LocalDurableTestRunner.teardownTestEnvironment()

  // The local runner keeps a worker_threads checkpoint server alive, so exit explicitly
  // once spans have flushed (flushInterval: 0 flushes each span as it finishes).
  setTimeout(() => process.exit(0), 500)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
