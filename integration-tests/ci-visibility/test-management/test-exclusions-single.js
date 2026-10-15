'use strict'

const { preventFailureSuppression, noAutoRetry } = require('dd-trace/test-optimization')
if (process.env.EXCLUSIONS_HOOK_FAILURE) {
  beforeEach(() => { throw new Error('protected hook failure') })
}
test('sole protected failure', preventFailureSuppression(noAutoRetry(() => {
  throw new Error('protected body failure')
})))
