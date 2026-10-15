'use strict'

const { preventFailureSuppression, noAutoRetry } = require('./packages/dd-trace/src/ci-visibility/test-annotations')

module.exports = { preventFailureSuppression, noAutoRetry }
