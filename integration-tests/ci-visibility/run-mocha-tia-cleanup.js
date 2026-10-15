'use strict'

const assert = require('node:assert/strict')

const MochaPackage = require('mocha')
const Mocha = MochaPackage.default ?? MochaPackage
const mocha = new Mocha()
for (const file of process.argv.slice(2)) mocha.addFile(file)
mocha.run(failures => {
  assert.ok(mocha.suite._onlyTests.every(test => mocha.suite.tests.includes(test)))
  assert.ok(mocha.suite._onlySuites.every(suite => mocha.suite.suites.includes(suite)))
  process.stdout.write('EXCLUSIVITY REFERENCES CLEANED\n')
  process.exitCode = failures ? 1 : 0
})
