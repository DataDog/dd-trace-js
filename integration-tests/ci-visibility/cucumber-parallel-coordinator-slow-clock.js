'use strict'

// Skew only the coordinator's instrumentation timing so the regression proves
// parallel suite status uses the worker-reported EFD retry count.
if (!process.env.CUCUMBER_WORKER_ID) {
  const { performance } = require('node:perf_hooks')
  const originalNow = performance.now.bind(performance)
  let calls = 0

  performance.now = function () {
    const now = originalNow()
    const stack = new Error().stack || ''
    if (stack.includes('packages/datadog-instrumentations/src/cucumber.js')) {
      return now + (calls++ * 6000)
    }
    return now
  }
}
