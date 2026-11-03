'use strict'

const { noAutoRetry } = require('dd-trace/ci/test-annotations')

function fail () { throw new Error('quarantined until Attempt to Fix is restored') }
test('annotation removal', process.env.JEST_RUN_INDEX === '2' ? fail : noAutoRetry(fail))
