import { describe, test, expect } from 'vitest'

let numAttempt = 0

describe('attempt to fix tests', () => {
  test('can attempt to fix a test', () => {
    // eslint-disable-next-line no-console
    console.log('I am running') // to check if this is being run
    if (process.env.SHOULD_ALWAYS_PASS) {
      expect(1 + 2).to.equal(3)
    } else if (process.env.SHOULD_FAIL_SOMETIMES) {
      // We need the last attempt to fail for the exit code to be 1
      if (numAttempt++ % 2 === 1) {
        expect(1 + 2).to.equal(4)
      } else {
        expect(1 + 2).to.equal(3)
      }
    } else {
      expect(1 + 2).to.equal(4)
    }
  })
})
