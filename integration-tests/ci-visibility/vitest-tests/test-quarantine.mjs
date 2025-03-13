import { describe, test, expect } from 'vitest'

describe('quarantine tests', () => {
  test('can quarantine a test', () => {
    // eslint-disable-next-line no-console
    console.log('I am running when quarantined') // to check if this is being run
    expect(1 + 2).to.equal(4)
  })

  test('can pass normally', () => {
    expect(1 + 2).to.equal(3)
  })
})
