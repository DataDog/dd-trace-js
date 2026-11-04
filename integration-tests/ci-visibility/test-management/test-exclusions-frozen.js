'use strict'

const { preventFailureSuppression, noAutoRetry } = require('dd-trace/ci/test-annotations')

for (const [name, helper] of Object.entries({
  original: fn => fn,
  preventFailureSuppression,
  noAutoRetry,
  combined: fn => preventFailureSuppression(noAutoRetry(fn)),
})) {
  test(name, helper(Object.freeze(function callback () {
    expect(42).toBe(42)
  })))
}
