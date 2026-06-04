import { describe, test, expect } from 'vitest'

let attempt = 0

describe('quarantine tests with retries', () => {
  test('can quarantine a test that eventually passes', () => {
    // eslint-disable-next-line no-console
    console.log('I am running when quarantined and eventually passes')
    expect(attempt++).to.equal(2)
  })
})
