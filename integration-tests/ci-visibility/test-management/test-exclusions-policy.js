'use strict'

const { preventFailureSuppression, noAutoRetry } = require('dd-trace/test-optimization')

function fail () { throw new Error('annotation failure') }

test('protected disabled', preventFailureSuppression(fail))
test('protected quarantined', preventFailureSuppression(fail))
test('protected both', preventFailureSuppression(noAutoRetry(fail)))
const eachProtectedCase = test.each([1, 2])
eachProtectedCase('protected case %s', preventFailureSuppression(fail))
test('ordinary disabled', fail)
test('ordinary quarantined', fail)
test.skip('developer skipped', preventFailureSuppression(fail))
test('protected done', preventFailureSuppression(done => done(new Error('done failure'))))
