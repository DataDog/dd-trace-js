import { describe, test, expect } from 'vitest'
import { sum } from './bad-sum'

let attempt = 0

function wait (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('dynamic instrumentation with concurrent tests', () => {
  test('serial retry does not use Failed Test Replay', () => {
    if (attempt++ === 0) {
      expect(sum(11, 2)).to.equal(13)
    } else {
      expect(sum(1, 2)).to.equal(3)
    }
  })

  test.concurrent('concurrent test disables Failed Test Replay for the file', async () => {
    await wait(1)
    expect(sum(1, 2)).to.equal(3)
  })
})
