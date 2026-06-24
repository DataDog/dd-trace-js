import { LocalDurableTestRunner } from '@aws/durable-execution-sdk-js-testing'
import { withDurableExecution } from '@aws/durable-execution-sdk-js'

// Loaded as a real ES module so dd-trace's ESM loader hook exercises the Orchestrion
// rewrite of the SDK's `dist/index.mjs` entry (the CJS `dist-cjs/index.js` path is
// covered by the unit suite). The local runner drives the handler with no AWS infra.
await LocalDurableTestRunner.setupTestEnvironment()

const handlerFunction = withDurableExecution(async (event, ctx) => {
  await ctx.step('verify-step', async () => {})
})

const runner = new LocalDurableTestRunner({ handlerFunction })
await runner.run({ payload: { testInput: true } })

await LocalDurableTestRunner.teardownTestEnvironment()

// The local runner keeps a worker_threads checkpoint server alive, so exit explicitly
// once spans have flushed (the harness sets DD_TRACE_FLUSH_INTERVAL=0).
setTimeout(() => process.exit(0), 500)
