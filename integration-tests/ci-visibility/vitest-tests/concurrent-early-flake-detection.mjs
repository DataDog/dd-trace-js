import { describe, test, expect } from 'vitest'

let eventuallyPassAttempts = 0

function wait (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('concurrent early flake detection', () => {
  test.concurrent('can retry concurrent tests that eventually pass', async () => {
    await wait(20)
    expect(1 + 2).to.equal(eventuallyPassAttempts++ === 0 ? 4 : 3)
  })

  test.concurrent('can retry concurrent tests that always pass', async () => {
    await wait(10)
    expect(1 + 2).to.equal(3)
  })

  test('can retry non-concurrent tests in a mixed suite', async () => {
    await wait(5)
    expect(1 + 2).to.equal(3)
  })
})
