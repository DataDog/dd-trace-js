'use strict'

const os = require('node:os')

module.exports = {
  color: true,
  exit: true,
  jobs: Math.min(os.cpus().length, 8),
  timeout: 5000,
  reporter: 'mocha-multi-reporters',
  reporterOption: [
    'configFile=.mochamultireporterrc.js'
  ]
}
