'use strict'

const assert = require('node:assert/strict')

const {
  getAutoTestRetriesFailureDiagnosis,
} = require('../../../../ci/test-optimization-validation/scenarios/auto-test-retries')

describe('test optimization auto test retries diagnosis', () => {
  it('explains when the failing generated test was reported but not retried', () => {
    const diagnosis = getAutoTestRetriesFailureDiagnosis({
      framework: 'vitest',
    }, {
      failedAttempts: 1,
      passedAttempts: 0,
      retryLikeEvents: 0,
    })

    assert.match(diagnosis, /Auto Test Retries was enabled/)
    assert.match(diagnosis, /Vitest did not execute a retry attempt/)
    assert.match(diagnosis, /Observed 1 failed attempt, 0 passed retry attempts/)
    assert.match(diagnosis, /no test\.retry_reason=auto_test_retry tag/)
  })
})
