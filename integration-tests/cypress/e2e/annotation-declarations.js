'use strict'

/* global expect */
/* eslint-disable mocha/no-identical-title -- Identical titles verify independent declaration metadata. */

const { preventFailureSuppression, noAutoRetry } = require('dd-trace/ci/test-annotations')
const { getTestEnvironment } = require('../support/test-environment')

function unexpectedExecution () { throw new Error('skipped callback executed') }

// Read the public mode before declarations, including Cypress 16's expose API.
if (getTestEnvironment('EXCLUSIONS_MODE') === 'pending-suite') {
  it('mode selected', noAutoRetry(() => {}))
}

for (const mode of ['duplicate-skipped', 'duplicate-mixed', 'duplicate-skipped-first']) {
  describe(mode, () => {
    // Cover a skipped declaration before an executed sibling with the same title.
    if (mode === 'duplicate-skipped-first') {
      // Preserve the skipped declaration before its executed sibling.
      it.skip('duplicate declaration', noAutoRetry(unexpectedExecution))
    }
    if (mode === 'duplicate-skipped') {
      // All siblings are pending in this variant.
      // Unannotated siblings must not inherit metadata.
      it.skip('duplicate declaration', preventFailureSuppression(unexpectedExecution))
    } else {
      it('duplicate declaration', preventFailureSuppression(() => {}))
    }
    // Also cover an executed declaration before its skipped sibling.
    if (mode !== 'duplicate-skipped-first') {
      // Preserve the skipped declaration after its executed sibling.
      it.skip('duplicate declaration', noAutoRetry(unexpectedExecution))
    }
    // Unannotated siblings must not inherit metadata.
    it.skip('duplicate declaration', unexpectedExecution)
  })
}

let ordinaryLine
it('ordinary declaration source', function () {
  ordinaryLine = this.test.invocationDetails.line
  expect(ordinaryLine).to.be.a('number')
})

specify('annotated declaration source', noAutoRetry(function () {
  const annotatedLine = this.test.invocationDetails.line
  expect(annotatedLine).to.be.a('number')
  expect(annotatedLine).not.to.equal(ordinaryLine)
}))
require('./skipped-suite-annotations')
