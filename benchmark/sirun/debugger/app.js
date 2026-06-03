'use strict'

// WARNING: the breakpoint targets below are referenced by line number from
// meta.json (BREAKPOINT_LINE). Update meta.json if you move `data.n = n` or the
// `dummy()` body.

const guard = require('../startup-guard')

const ITERATIONS = Number(process.env.ITERATIONS) || 5000

if (process.env.DD_DYNAMIC_INSTRUMENTATION_ENABLED === 'true') {
  // The devtools worker and its ports are unref'd, so nothing holds the event
  // loop open while the breakpoint installs. Keep it alive until the install
  // ack, then run the loop so the probe fires on every iteration instead of
  // racing its installation.
  const keepAlive = setInterval(() => {}, 2 ** 31 - 1)
  require('./start-devtools-client')(() => {
    clearInterval(keepAlive)
    // The not-hit variant only measures the passive cost of installing a probe,
    // so it exits here instead of running the guarded work loop.
    if (process.env.INSTALL_ONLY !== 'true') runWork()
  })
} else {
  runWork()
}

function runWork () {
  guard.loopStart()
  for (let i = 0; i < ITERATIONS; i++) {
    doSomeWork(i)
  }
  guard.done(0.20)
}

function doSomeWork (n) {
  const data = getSomeData()
  data.n = n
  return data.n
}

// Never executed: breakpoint target for the not-hit baseline variant.
// eslint-disable-next-line no-unused-vars
function dummy () {
  throw new Error('This line should never execute')
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
