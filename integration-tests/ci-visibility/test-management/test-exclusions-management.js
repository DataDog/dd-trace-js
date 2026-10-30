'use strict'

const { preventFailureSuppression, noAutoRetry } = require('dd-trace/test-optimization')

function fail () { throw new Error('annotation failure') }

test('excluded disabled', noAutoRetry(fail))
test('excluded quarantined', noAutoRetry(fail))
test('protected passing', preventFailureSuppression(() => {}))
