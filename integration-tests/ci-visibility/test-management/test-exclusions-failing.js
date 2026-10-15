'use strict'

const { preventFailureSuppression, noAutoRetry } = require('dd-trace/test-optimization')
const failing = test.failing.each([1, 2])
failing('expected failure %s', preventFailureSuppression(noAutoRetry(() => { throw new Error('expected failure') })))
