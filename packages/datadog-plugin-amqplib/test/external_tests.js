'use strict'

const testConfigs = [
  {
    integration: 'amqplib',
    repo: 'https://github.com/squaremo/amqp.node',
    framework: 'mocha',
    args: '--check-leaks --exit -u tdd test/'
  }
]

module.exports = testConfigs
