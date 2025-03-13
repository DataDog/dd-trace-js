import { describe, test, expect } from 'vitest'

describe('disable tests', () => {
  test('can disable a test', () => {
    // eslint-disable-next-line no-console
    console.log('I am running') // to check if this is being run
    expect(1 + 2).to.equal(4)
  })
})
