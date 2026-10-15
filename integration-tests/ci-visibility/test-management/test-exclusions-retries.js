'use strict'

const { preventFailureSuppression, noAutoRetry } = require('dd-trace/test-optimization')

function fail () { throw new Error('annotation failure') }

test('excluded', noAutoRetry(fail))
test('control', fail)
test('must fail still retries', preventFailureSuppression(fail))
const eachExcludedCase = test.each([1, 2])
eachExcludedCase('excluded case %s', noAutoRetry(fail))
test.each`
value
${1}
${2}
`('excluded template $value', noAutoRetry(fail))
