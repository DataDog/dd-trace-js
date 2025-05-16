'use strict'

const DDTrace = require('dd-trace')
const tracer = DDTrace.init()
const NativeWallProfiler = require('dd-trace/packages/dd-trace/src/profiling/profilers/wall')


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
  const id1 = `x-${counter}`
  tracer.trace(id1, { type: 'web', resource: `endpoint-${counter}` }, (_, done) => {
    logData(id1)
    setImmediate(() => {
      logData(`${id1} timeout`)
      for (let i = 0; i < 3; ++i) {
        const z = i
        const id2 = `y-${counter}-${i}`
        tracer.trace(id2, (_, done2) => {
          logData(id2)
          const busyWork = () => {
            logData(`${id2}-timeout`)
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

function logData (codeContext) {
  const active = NativeWallProfiler.prototype.getActiveSpan()
  const sampleContext = NativeWallProfiler.prototype.getSampleContext()
  const indicator = (active.spanId === sampleContext.spanId) ? '✅' : '❌'
  console.log(indicator, codeContext, 'activeSpan:', active.spanId, ', sampleContext:', sampleContext.spanId)
}

tracer.profilerStarted().then(runBusySpans)
