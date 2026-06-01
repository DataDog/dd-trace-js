'use strict'

describe('worker restart known tests spacer', () => {
  it('is a spacer to trigger worker restart', () => {
    // Occupies the worker so that workerIdleMemoryLimit triggers a restart
    // before the actual test suites run.
  })
})
