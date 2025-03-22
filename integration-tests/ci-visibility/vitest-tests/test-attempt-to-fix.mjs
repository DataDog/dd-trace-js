import { describe, test, expect } from 'vitest'

describe('attempt to fix tests', () => {
  test('can attempt to fix a test', () => {
    // eslint-disable-next-line no-console
    console.log('I am running') // to check if this is being run
    expect(1 + 2).to.equal(4)
  })
})
