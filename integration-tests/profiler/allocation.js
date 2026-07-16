'use strict'

require('dd-trace').init({ profiling: true })

const durationMs = Number.parseInt(process.env.TEST_DURATION_MS ?? '5000')

function runAllocations (ms) {
  return new Promise(resolve => {
    const allocations = []
    const end = Date.now() + ms

    function work () {
      if (Date.now() >= end) {
        resolve()
        return
      }

      for (let i = 0; i < 1000; i++) {
        allocations.push({ index: i, values: [i, i + 1, i + 2] })
      }

      if (allocations.length > 10000) {
        allocations.splice(0, 5000)
      }

      setImmediate(work)
    }

    work()
  })
}

runAllocations(durationMs).catch(err => {
  process.exitCode = 1
})
