'use strict'

const DDTrace = require('dd-trace')

const tracer = DDTrace.init()

function busyLoop () {
  const start = process.hrtime.bigint()
  for (;;) {
    const now = process.hrtime.bigint()
    // Busy cycle for 20ms
    if (now - start > 20000000n) {
      break
    }
  }
}

let counter = 0

function runBusySpans () {
  tracer.trace('x' + counter, (span, done) => {
    span.setTag('span.type', 'web')
    span.setTag('resource.name', `endpoint-${counter}`)
    setImmediate(() => {
      for (let i = 0; i < 3; ++i) {
        const z = i
        tracer.trace('y' + i, (span2, done2) => {
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

setTimeout(runBusySpans, 100)
