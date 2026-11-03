'use strict'

const { preventFailureSuppression, noAutoRetry } = require('dd-trace/ci/test-annotations')

function fail () { throw new Error('annotation failure') }

test('excluded disabled', noAutoRetry(fail))
test('excluded quarantined', noAutoRetry(fail))
test('protected passing', preventFailureSuppression(() => {}))
