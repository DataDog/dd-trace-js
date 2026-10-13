'use strict'

const MochaPackage = require('mocha')
const Mocha = MochaPackage.default ?? MochaPackage

const testFile = require.resolve('./known-flakes/mocha-repeated.js')

/** @param {(failures: number) => void} done */
function run (done) {
  // Reload declarations for each Mocha instance, while retaining the tracer in this process.
  delete require.cache[testFile]
  const mocha = new Mocha()
  mocha.addFile(testFile)
  mocha.run(done)
}

// Keep this watch-style process alive between runs and start each invocation outside the previous callback.
process.once('message', () => {
  run(failures => {
    process.exitCode = failures ? 1 : 0
    process.disconnect()
  })
})
run(() => process.send('first run finished'))
