'use strict'

/* global context, xcontext, xdescribe */

const { noAutoRetry, preventFailureSuppression } = require('dd-trace/test-optimization')

const originalIt = it
const originalSpecify = specify
function fail () { throw new Error('skipped callback executed') }

for (const [label, skippedSuite] of [
  ['describe.skip', describe.skip], ['context.skip', context.skip], ['xdescribe', xdescribe], ['xcontext', xcontext],
]) {
  skippedSuite(label, () => {
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
})

try {
  // Verify temporary declaration wrappers are restored even if a skipped suite throws.
  describe.skip('declaration failure cleanup', () => { throw new Error('expected suite declaration error') })
} catch (error) {
  if (error.message !== 'expected suite declaration error') throw error
}
if (it !== originalIt || specify !== originalSpecify) throw new Error('declaration exception did not restore globals')
