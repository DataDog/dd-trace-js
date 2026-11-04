import { describe, expect } from 'vitest'
import { noAutoRetry, preventFailureSuppression } from 'dd-trace/ci/test-annotations'

/** @param {(name: string, callback: Function) => Function} tracked */
export function declareSuiteLocalTests (tracked) {
  const fail = () => { throw new Error('suite-local failure') }
  const protect = name => preventFailureSuppression(noAutoRetry(tracked(name, fail)))
  describe('local', localTest => {
    localTest('direct', protect('local direct'))
    const cases = localTest.each([1, 2])
    cases('each %s', protect('local each'))
    localTest.concurrent('concurrent', protect('local concurrent'))
    const conditional = localTest.skipIf(false).runIf(true)
    conditional('conditional', protect('local conditional'))
    const fixtureTest = localTest.extend({ value: 'fixture value' })
    fixtureTest('fixture', preventFailureSuppression(noAutoRetry(function ({ value }) {
      expect(value).toBe('fixture value')
      const failFixture = tracked('local fixture', fail)
      failFixture()
    })))
    if (localTest.for) {
      const forCases = localTest.for([1, 2])
      forCases('for %s', protect('local for'))
    }
    localTest('native', { retry: 1 }, protect('local native'))
    describe('inherited', { retry: 1 }, nestedTest => {
      nestedTest('native', protect('local inherited native'))
    })
    localTest('protected retries', preventFailureSuppression(tracked('local protected retries', fail)))
    localTest('control', tracked('local control', fail))
  })
}
