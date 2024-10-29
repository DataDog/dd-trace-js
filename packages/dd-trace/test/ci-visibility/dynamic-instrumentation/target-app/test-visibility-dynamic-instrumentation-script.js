'use strict'

const path = require('path')
const tvDynamicInstrumentation = require('../../../../src/ci-visibility/dynamic-instrumentation')
const sum = require('./di-dependency')

tvDynamicInstrumentation.start()

const [
  snapshotId,
  breakpointHitPromise
] = tvDynamicInstrumentation.addLineProbe({ file: path.join(__dirname, 'di-dependency.js'), line: 9 })

breakpointHitPromise.then(({ snapshot }) => {
  // once the breakpoint is hit, we can grab the snapshot and send it to the parent process
  process.send({ snapshot, snapshotId })
})

// TODO: 100ms because the breakpoint is not set immediately.
// We have to return a promise that's resolved when the breakpoint is available
setTimeout(() => {
  sum(1, 2)
}, 100)
