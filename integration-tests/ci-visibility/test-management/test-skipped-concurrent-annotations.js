'use strict'

const { noAutoRetry, preventFailureSuppression } = require('dd-trace/test-optimization')

const skippedRows = test.concurrent.skip.each([1, 2])
skippedRows('excluded skipped row %s', noAutoRetry(async () => { throw new Error('must remain skipped') }))
skippedRows('protected skipped row %s', preventFailureSuppression(noAutoRetry(async () => {
  throw new Error('must remain skipped')
})))
test('ordinary control', () => {})
