'use strict'

let executions = 0
const retryDoneCallbacks = []
const retryCount = Number(process.env.EFD_RETRY_COUNT ?? 3)

test.concurrent('new concurrent test using a done callback', (done) => {
  if (executions++ === 0) {
    done()
    return
  }

  retryDoneCallbacks.push(done)
  if (retryDoneCallbacks.length === retryCount) {
    for (const finishRetry of retryDoneCallbacks) {
      finishRetry()
    }
  }
})
