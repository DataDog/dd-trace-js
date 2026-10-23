'use strict'

const { preventFailureSuppression, noAutoRetry } = require('dd-trace/test-optimization')

for (const [name, helper] of Object.entries({
  preventFailureSuppression,
  noAutoRetry,
  combined: fn => preventFailureSuppression(noAutoRetry(fn)),
})) {
  test(name, helper(function * () {
    const value = yield Promise.resolve(42)
    expect(value).toBe(42)
  }))
}
