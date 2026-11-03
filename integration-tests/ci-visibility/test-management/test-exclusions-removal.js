'use strict'

const { preventFailureSuppression, noAutoRetry } = require('dd-trace/ci/test-annotations')
function fail () { throw new Error('protected first execution') }
const callback = process.env.JEST_RUN_INDEX === '2' ? fail : preventFailureSuppression(noAutoRetry(fail))
test('annotation removal', callback)
