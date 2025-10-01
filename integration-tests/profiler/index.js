'use strict'

require('dd-trace').init()

function busyWait (ms) {
  return /** @type {Promise<void>} */ (new Promise(resolve => {
    let done = false
    function work () {
      if (done) return
      let sum = 0
      for (let i = 0; i < 1e6; i++) {
        sum += sum
      }
      setImmediate(work, sum)
    }
    setImmediate(work)
    setTimeout(() => {
      done = true
      resolve()
    }, ms)
  }))
}

const durationMs = Number.parseInt(process.env.TEST_DURATION_MS ?? '500')
setImmediate(async () => busyWait(durationMs))
