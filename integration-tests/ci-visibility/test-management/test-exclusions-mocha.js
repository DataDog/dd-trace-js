'use strict'

const { preventFailureSuppression, noAutoRetry } = require('dd-trace/test-optimization')

function callback () {
  if (process.env.EXCLUSION_COUNT_ATTEMPTS === '1') process.stdout.write('exclusion-body-attempt\n')
  if (process.env.EXCLUSION_PASS !== '1') throw new Error('protected failure')
}
let annotated = callback
if (process.env.EXCLUSION_PROTECT === '1') annotated = preventFailureSuppression(annotated)
if (process.env.EXCLUSION_NO_RETRY === '1') annotated = noAutoRetry(annotated)
it('annotated test', annotated)
// Developer selection must remain effective even with both annotations.
it.skip('developer skip', preventFailureSuppression(noAutoRetry(callback)))
