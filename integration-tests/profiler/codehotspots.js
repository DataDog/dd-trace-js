'use strict'

const DDTrace = require('dd-trace')
const tracer = DDTrace.init()

// Busy cycle duration is communicated in nanoseconds through the environment
// variable by the test. On first execution, it'll be 10 * the sampling period
// at 99Hz (so, 101010101ns). If subsequent executions are needed, it will be
// prolonged.
const busyCycleTime = BigInt(process.env.BUSY_CYCLE_TIME)

function busyLoop () {
  const start = process.hrtime.bigint()
  for (;;) {
    const now = process.hrtime.bigint()
    // Busy cycle
    if (now - start > busyCycleTime) {
      break
    }
  }
}

let counter = 0

function runBusySpans () {
  tracer.trace('x' + counter, { type: 'web', resource: `endpoint-${counter}` }, (_, done) => {
    setImmediate(() => {
      for (let i = 0; i < 3; ++i) {
        const z = i
        tracer.trace('y' + i, (_, done2) => {
          setTimeout(() => {
            busyLoop()
            done2()
            if (z === 2) {
              if (++counter < 3) {
                setTimeout(runBusySpans, 0)
              }
              done()
            }
          }, 0)
        })
      }
    })
  })
}

tracer.profilerStarted().then(runBusySpans)
