'use strict'

// WARNING: the breakpoint targets below are referenced by line number from
// meta.json (BREAKPOINT_LINE). Update the BREAKPOINT_LINE values there if you
// move the `data.n = n` line or the unreachable `return n` line.

const guard = require('../startup-guard')

const OPERATIONS = Number(process.env.OPERATIONS)
const STARTUP_GUARD_MAX_SHARE = Number(process.env.STARTUP_GUARD_MAX_SHARE)

if (process.env.DD_DYNAMIC_INSTRUMENTATION_ENABLED === 'true') {
  // The devtools worker and its ports are unref'd, so nothing holds the event
  // loop open while the breakpoint installs. Keep it alive until the install
  // ack, then run the loop so the probe fires on every iteration instead of
  // racing its installation.
  const keepAlive = setInterval(() => {}, 2 ** 31 - 1)
  require('./start-devtools-client')(() => {
    clearInterval(keepAlive)
    runWork()
  })
} else {
  runWork()
}

function runWork () {
  guard.loopStart()
  for (let i = 0; i < OPERATIONS; i++) {
    doSomeWork(i)
  }
  guard.done(STARTUP_GUARD_MAX_SHARE)
}

function doSomeWork (n) {
  const data = getSomeData()
  data.n = n // BREAKPOINT HERE!
  if (n < 0) {
    return n // BREAKPOINT HERE!
  }
  return data.n
}

function getSomeData () {
  const str = 'a'.repeat(1000)
  const arr = Array.from({ length: 1000 }, (_, i) => i)

  const data = {
    foo: 'bar',
    nil: null,
    undef: undefined,
    bool: true,
  }
  data.recursive = data

  for (let i = 0; i < 20; i++) {
    data[`str${i}`] = str
    data[`arr${i}`] = arr
  }

  return data
}
