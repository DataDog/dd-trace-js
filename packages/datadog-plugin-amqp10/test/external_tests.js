'use strict'

const tests = './test/unit ./test/integration/qpid ./test/integration/servicebus'

const testConfigs = [
  {
    integration: 'amqp10',
    repo: 'https://github.com/noodlefrenzy/node-amqp10/',
    branch: 'master',
    framework: 'mocha',
    args: `--recursive --exit --check-leaks -R spec -t 5000 ${tests}`
  }
]

module.exports = testConfigs
