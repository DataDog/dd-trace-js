'use strict'

const MochaPackage = require('mocha')
const Mocha = MochaPackage.default ?? MochaPackage

const mocha = new Mocha()
for (const file of process.argv.slice(2)) mocha.addFile(file)
mocha.run(failures => { process.exitCode = failures ? 1 : 0 })
