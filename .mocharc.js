'use strict'

module.exports = {
  allowUncaught: true,
  color: true,
  exit: true,
  timeout: 5000,
  require: ['packages/dd-trace/test/setup/mocha.js'],
  reporter: 'mocha-multi-reporters',
  reporterOption: [
    'configFile=.mochamultireporterrc.js',
  ],
}
