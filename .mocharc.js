'use strict'

module.exports = {
  color: true,
  exit: true,
  timeout: 5000,
  reporter: 'mocha-multi-reporters',
  reporterOption: [
    'configFile=.mochamultireporterrc.js'
  ]
}

