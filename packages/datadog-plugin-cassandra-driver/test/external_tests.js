'use strict'

const defaultConfig = {
  integration: 'cassandra-driver',
  repo: 'https://github.com/datastax/nodejs-driver',
  testType: 'mocha',
  testArgs: '-R spec -t 5000 --recursive --exit test/unit'
}

module.exports = {
  defaultConfig
}
