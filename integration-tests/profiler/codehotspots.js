'use strict'

const DDTrace = require('dd-trace')

const tracer = DDTrace.init()

function busyLoop () {
  const start = process.hrtime.bigint()
  for (;;) {
    const now = process.hrtime.bigint()
    // Busy cycle for 100ms
    if (now - start > 100000000n) {
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
