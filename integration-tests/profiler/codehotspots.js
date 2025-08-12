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
  let x = 0
  for (;;) {
    const now = process.hrtime.bigint()
    // Busy cycle
    if (now - start > busyCycleTime) {
      break
    }
    // Do something in addition to invoking hrtime
    for (let i = 0; i < 1000; i++) {
      x += Math.sqrt(Math.random() * 2 - 1)
    }
  }
  return x
}

let counter = 0

function runBusySpans () {
  tracer.trace('x' + counter, { type: 'web', resource: `endpoint-${counter}` }, (_, done) => {
    setImmediate(() => {
      for (let i = 0; i < 3; ++i) {
        const z = i
        tracer.trace('y' + i, (_, done2) => {
          const busyWork = () => {
            busyLoop()
            done2()
            if (z === 2) {
              if (++counter < 3) {
                setTimeout(runBusySpans, 0)
              }
              done()
            }
          }
          if (i === 1) {
            // Exercise sample context propagation through a promise
            const p = new Promise((resolve) => {
              setTimeout(resolve, 0)
            })
            p.then(busyWork)
          } else {
            // Exercise sample context propagation through a timeout
            setTimeout(busyWork, 0)
          }
        })
      }
    })
  })
}

tracer.profilerStarted().then(runBusySpans)
