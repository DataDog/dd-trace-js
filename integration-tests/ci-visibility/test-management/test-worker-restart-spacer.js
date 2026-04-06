'use strict'

describe('worker restart spacer tests', () => {
  it('spacer test', () => {
    // This suite acts as filler so there are 3 suites total. With maxWorkers=1
    // and workerIdleMemoryLimit=0, the worker restarts after each suite.
    // By the 3rd suite the child process has been replaced and its send method
    // is no longer wrapped by sendWrapper unless the fix is in place.
  })
})
