'use strict'

const testConfigs = [
  {
    integration: 'amqp10',
    repo: 'https://github.com/noodlefrenzy/node-amqp10',
    framework: 'mocha',
    args: `--recursive --exit --check-leaks -R spec -t 5000 ./test/unit`
  }
]

module.exports = testConfigs
