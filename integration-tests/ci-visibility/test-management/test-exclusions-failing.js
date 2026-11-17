'use strict'

const { preventFailureSuppression, noAutoRetry } = require('dd-trace/ci/test-annotations')
const failing = test.failing.each([1, 2])
failing('expected failure %s', preventFailureSuppression(noAutoRetry(() => { throw new Error('expected failure') })))
