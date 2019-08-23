'use strict'

const execSync = require('child_process').execSync

const testConfigs = [
  {
    integration: 'amqplib',
    repo: 'https://github.com/squaremo/amqp.node',
    framework: 'mocha',
    args: '--check-leaks --exit -u tdd test/',
    setup (tracerSetupPath, options) {
      execSync('npm install && make lib/defs.js', options)
    }
  }
]

module.exports = testConfigs
