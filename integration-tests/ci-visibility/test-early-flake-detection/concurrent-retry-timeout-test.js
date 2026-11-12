'use strict'

let executions = 0
const originalDuration = Number(process.env.CONCURRENT_ORIGINAL_DURATION_MS)
const retryDuration = Number(process.env.CONCURRENT_RETRY_DURATION_MS)
const timeout = Number(process.env.CONCURRENT_TEST_TIMEOUT_MS)

test.concurrent('gives every attempt its own timeout', async () => {
  const duration = executions++ === 0 ? originalDuration : retryDuration
  await new Promise(resolve => setTimeout(resolve, duration))
}, timeout)
