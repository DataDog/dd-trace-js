'use strict'

let executions = 0

test.concurrent('new concurrent test passes after its original throws', () => {
  if (executions++ === 0) {
    throw new Error('original concurrent test throws')
  }
})
