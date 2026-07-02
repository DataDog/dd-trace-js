import { describe, expect, test } from 'vitest'

let attempt = 0

function wait (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('slow failing retry', () => {
  test('does not double report final failed retry', async () => {
    if (attempt++ > 0) {
      await wait(200)
    }
    expect(1).to.equal(2)
  })
})
