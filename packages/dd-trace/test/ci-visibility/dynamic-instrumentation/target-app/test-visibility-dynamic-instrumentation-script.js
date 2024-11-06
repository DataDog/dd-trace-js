'use strict'

const path = require('path')
const tvDynamicInstrumentation = require('../../../../src/ci-visibility/dynamic-instrumentation')
const sum = require('./di-dependency')

// keep process alive
const intervalId = setInterval(() => {}, 5000)

tvDynamicInstrumentation.start()

tvDynamicInstrumentation.isReady().then(() => {
  const [
    snapshotId,
    breakpointSetPromise,
    breakpointHitPromise
  ] = tvDynamicInstrumentation.addLineProbe({ file: path.join(__dirname, 'di-dependency.js'), line: 9 })

  breakpointHitPromise.then(({ snapshot }) => {
    // once the breakpoint is hit, we can grab the snapshot and send it to the parent process
    process.send({ snapshot, snapshotId })
    clearInterval(intervalId)
  })

  // We run the code once the breakpoint is set
  breakpointSetPromise.then(() => {
    sum(1, 2)
  })
})
