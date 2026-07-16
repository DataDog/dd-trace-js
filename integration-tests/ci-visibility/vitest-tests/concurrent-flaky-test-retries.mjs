import { describe, test, expect } from 'vitest'

let eventuallyPassAttempts = 0
let nonConcurrentEventuallyPassAttempts = 0

function wait (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('concurrent flaky test retries', () => {
  test.concurrent('can retry concurrent tests that eventually pass', async () => {
    await wait(20)
    expect(++eventuallyPassAttempts).to.equal(2)
  })

  test.concurrent('can retry concurrent tests that never pass', async () => {
    await wait(10)
    expect(1 + 2).to.equal(4)
  })

  test.concurrent('does not retry concurrent tests if unnecessary', async () => {
    await wait(5)
    expect(1 + 2).to.equal(3)
  })

  test('can retry non-concurrent tests in a mixed suite', async () => {
    await wait(1)
    expect(++nonConcurrentEventuallyPassAttempts).to.equal(2)
  })
})
