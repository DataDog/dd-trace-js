'use strict'

const execSync = require('child_process').execSync

const defaultConfig = {
  integration: 'amqp10',
  repo: 'https://github.com/noodlefrenzy/node-amqp10/',
  testType: 'mocha',
  testArgs: '--recursive --check-leaks -R spec -t 5000 ./test/unit ./test/integration/qpid ./test/integration/servicebus'
}

const testConfigs = [
  {
    branch: undefined
  }
]

module.exports = {
  defaultConfig,
  testConfigs
}
