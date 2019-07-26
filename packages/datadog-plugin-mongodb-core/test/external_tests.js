'use strict'

const path = require('path')
const fs = require('fs')
const execSync = require('child_process').execSync

const defaultConfig = {
  integration: 'mongodb-core',
  repo: 'https://github.com/mongodb-js/mongodb-core',
  testType: 'custom',
  testFn: function (tracerSetupPath, options) {
    const cwd = options.cwd
    const tracerSetupFilename = path.basename(tracerSetupPath)
    const tracerSetupFileLoc = path.join(cwd, 'test', 'tests', tracerSetupFilename)
    if (fs.existsSync(tracerSetupFileLoc)) {
      fs.copyFileSync(tracerSetupPath, tracerSetupFileLoc)
    }
    return execSync('npm run env -- mongodb-test-runner -t 60000 test/tests', options)
  },
  setup: function (cwd) {
    execSync('npm install', { cwd })
  }
}

const testConfigs = []

module.exports = {
  defaultConfig,
  testConfigs
}
