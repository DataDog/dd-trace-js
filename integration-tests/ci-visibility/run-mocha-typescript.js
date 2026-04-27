'use strict'

require(process.env.TYPESCRIPT_REGISTER)

const Mocha = require('mocha')

const mocha = new Mocha()
mocha.addFile(require.resolve('./typescript/transpiled-test.ts'))

mocha.run((failures) => {
  if (failures > 0) {
    process.exitCode = 1
  }
})
