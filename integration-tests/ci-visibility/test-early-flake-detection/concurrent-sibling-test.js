'use strict'

// The first test only finishes once its known sibling starts, so the suite deadlocks if
// originals or EFD retries consume every concurrency slot.
let releaseNewTest
const siblingStarted = new Promise(resolve => {
  releaseNewTest = resolve
})
let retryExecutions = 0
let releaseRetries
const retriesStarted = new Promise(resolve => {
  releaseRetries = resolve
})
const retryCount = Number(process.env.EFD_RETRY_COUNT ?? 5)

describe('early flake detection concurrent siblings', () => {
  test.concurrent('new test waits for its known sibling', async () => {
    await siblingStarted
    expect(1 + 2).toBe(3)
  })

  test.concurrent('known sibling releases the new test', () => {
    releaseNewTest()
    expect(2 + 2).toBe(4)
  })

  test.concurrent('runs its retries concurrently', async () => {
    const execution = retryExecutions++
    if (execution === 0) {
      throw new Error('concurrent original fails synchronously')
    }

    if (retryExecutions === retryCount + 1) {
      releaseRetries()
    }
    await retriesStarted
    if (execution === 1) {
      throw new Error('first concurrent retry fails')
    }
  })
})
