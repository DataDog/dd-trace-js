'use strict'
const vm = require('vm')

const path = require('path')
const tvDynamicInstrumentation = require('../../../../src/ci-visibility/dynamic-instrumentation')
// const sum = require('./di-dependency')
const fs = require('fs')

const filename = path.join(__dirname, 'di-dependency.js')

const code = fs.readFileSync(filename)

// keep process alive
const intervalId = setInterval(() => {}, 5000)

tvDynamicInstrumentation.start()

tvDynamicInstrumentation.isReady().then(() => {
  const filename = path.join(__dirname, 'di-dependency.js')
  console.log('filename', filename)
  const [
    snapshotId,
    breakpointSetPromise,
    breakpointHitPromise
  ] = tvDynamicInstrumentation.addLineProbe({ file: filename, line: 5 })

  breakpointHitPromise.then(({ snapshot }) => {
    // once the breakpoint is hit, we can grab the snapshot and send it to the parent process
    process.send({ snapshot, snapshotId })
    clearInterval(intervalId)
  })

  // We run the code once the breakpoint is set
  breakpointSetPromise.then(() => {
    console.log('now executing')
    const script = new vm.Script(code, { filename })

    // Create a new context (sandbox)
    const context = vm.createContext({ console, module })

    // Run the script in the context
    const sum = script.runInContext(context, { filename })

//     // const context = vm.createContext({ console, module })
//     const sum = vm.runInContext(`
// 'use strict'

// module.exports = function (a, b) {
//   // eslint-disable-next-line no-console
//   const localVar = 1
//   if (a > 10) {
//     throw new Error('a is too big')
//   }
//   return a + b + localVar // location of the breakpoint
// }
//       `, context, { filename })

  setTimeout(() => {
    console.log('sum', sum(1, 2))
  }, 1000)
    // sum(1, 2)
    // sum(1, 2)
  })
})
