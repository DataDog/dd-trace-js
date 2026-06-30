import { describe, test, expect } from 'vitest'

let numAttempt = 0

describe('attempt to fix tests', () => {
  test('can attempt to fix a test', () => {
    if (process.env.EXPECT_DD_TEST_OPT_VITEST_SETUP_ENV_ABSENT) {
      expect(process.env.DD_TEST_OPT_VITEST_ATTEMPT_TO_FIX_RETRIES).toBeUndefined()
      expect(process.env.DD_TEST_OPT_VITEST_ATTEMPT_TO_FIX_TESTS).toBeUndefined()
      expect(process.env.DD_TEST_OPT_VITEST_DISABLED_TESTS).toBeUndefined()
      expect(process.env.DD_TEST_OPT_VITEST_EFD_ENABLED).toBeUndefined()
      expect(process.env.DD_TEST_OPT_VITEST_EFD_RETRIES).toBeUndefined()
      expect(process.env.DD_TEST_OPT_VITEST_EFD_SLOW_RETRIES).toBeUndefined()
      expect(process.env.DD_TEST_OPT_VITEST_KNOWN_TESTS).toBeUndefined()
      expect(process.env.DD_TEST_OPT_VITEST_REPOSITORY_ROOT).toBeUndefined()
    }

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
    } else if (process.env.SHOULD_FAIL_FIRST_ONLY) {
      // First attempt fails, all retries pass. Exit code must still be 1
      // for plain ATF tests (not quarantined/disabled).
      if (numAttempt++ === 0) {
        expect(1 + 2).to.equal(4)
      } else {
        expect(1 + 2).to.equal(3)
      }
    } else {
      expect(1 + 2).to.equal(4)
    }
  })
})
