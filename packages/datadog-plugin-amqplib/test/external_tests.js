'use strict'

const defaultConfig = {
  integration: 'amqplib',
  repo: 'https://github.com/squaremo/amqp.node',
  testType: 'mocha',
  testArgs: '--check-leaks -u tdd test/'
}

const testConfigs = [
  {
    branch: 'master'
  }
]

module.exports = {
  defaultConfig,
  testConfigs
}
