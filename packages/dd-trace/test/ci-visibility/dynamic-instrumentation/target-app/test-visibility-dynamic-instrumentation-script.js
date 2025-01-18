'use strict'

const path = require('path')
const tvDynamicInstrumentation = require('../../../../src/ci-visibility/dynamic-instrumentation')
const sum = require('./di-dependency')
const Config = require('../../../../src/config')

// keep process alive
const intervalId = setInterval(() => {}, 5000)

tvDynamicInstrumentation.start(new Config())

tvDynamicInstrumentation.isReady().then(() => {
  const file = path.join(__dirname, 'di-dependency.js')
  const [probeId, breakpointSetPromise] = tvDynamicInstrumentation.addLineProbe(
    { file, line: 9 },
    ({ snapshot }) => {
      // once the breakpoint is hit, we can grab the snapshot and send it to the parent process
      process.send({ snapshot, probeId })
      clearInterval(intervalId)
    }
  )

  // We run the code once the breakpoint is set
  breakpointSetPromise.then(() => {
    sum(1, 2)
  })
})
