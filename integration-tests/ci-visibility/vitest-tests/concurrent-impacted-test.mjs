import { describe, test, expect } from 'vitest'

describe('concurrent impacted test', () => {
  test.concurrent('can mark first concurrent impacted test', () => {
    expect(1 + 2).to.equal(3)
  })

  test.concurrent('can mark second concurrent impacted test', () => {
    expect(2 + 2).to.equal(4)
  })

  test('can mark a non-concurrent impacted test in the same suite', () => {
    expect(3 + 2).to.equal(5)
  })
})
