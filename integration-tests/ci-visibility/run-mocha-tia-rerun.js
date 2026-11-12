'use strict'

const tracer = require('dd-trace')
const MochaPackage = require('mocha')
const Mocha = MochaPackage.default ?? MochaPackage

const mocha = new Mocha()
mocha.cleanReferencesAfterRun(false)
for (const file of process.argv.slice(2)) mocha.addFile(file)
mocha.loadFiles()

process.once('message', () => {
  if (process.env.MOCHA_TIA_RERUN_MODE === 'disabled-plugin') tracer.use('mocha', false)
  mocha.run(failures => {
    process.stdout.write(`SECOND RUN FAILURES: ${failures}\n`)
    process.exitCode = failures ? 1 : 0
    process.disconnect()
  })
})

mocha.run(failures => { process.send(failures) })
