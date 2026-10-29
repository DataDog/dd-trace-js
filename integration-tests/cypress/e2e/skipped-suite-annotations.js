'use strict'

/* global context, xcontext, xdescribe, window */

const { noAutoRetry, preventFailureSuppression } = require('dd-trace/test-optimization')
const { getTestEnvironment } = require('../support/test-environment')

const originalIt = it
const originalSpecify = specify
let skippedExecutions = 0
let executed = 0
function reportExecutions () {
  return window.fetch(getTestEnvironment('PENDING_LEDGER_URL'), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ skipped: skippedExecutions, executed }),
  }).then(response => {
    if (!response.ok) throw new Error('Native callback ledger was not recorded')
  })
}
function fail () {
  skippedExecutions++
  return reportExecutions().then(() => { throw new Error('skipped callback executed') })
}

for (const [label, skippedSuite] of [
  ['describe.skip', describe.skip], ['context.skip', context.skip], ['xdescribe', xdescribe], ['xcontext', xcontext],
]) {
  skippedSuite(label, () => {
    originalIt('alias both flags', preventFailureSuppression(noAutoRetry(fail)))
    originalSpecify('alias retry flag', noAutoRetry(fail))
    it('both flags', preventFailureSuppression(noAutoRetry(fail)))
    specify('retry flag', noAutoRetry(fail))
    it('ordinary skipped', fail)
    describe('inherited pending', () => {
      it('protected flag', preventFailureSuppression(fail))
    })
    // Verify nested pending declarations retain metadata without executing callbacks.
    describe.skip('nested pending', () => {
      it('nested skip flags', preventFailureSuppression(noAutoRetry(fail)))
    })
  })
}

it('execution after pending declarations', function () {
  if (it !== originalIt || specify !== originalSpecify) throw new Error('declaration globals were not restored')
  executed++
  return reportExecutions()
})
