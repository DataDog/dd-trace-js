'use strict'

const defaultConfig = {
  integration: 'amqplib',
  repo: 'https://github.com/squaremo/amqp.node',
  testType: 'mocha',
  testArgs: '--check-leaks --exit -u tdd test/'
}

module.exports = {
  defaultConfig
}
