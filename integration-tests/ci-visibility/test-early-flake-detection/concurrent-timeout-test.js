'use strict'

let executions = 0

test.concurrent('new concurrent test passes after its original times out', () => {
  if (executions++ === 0) {
    return new Promise(() => {})
  }
}, 50)
