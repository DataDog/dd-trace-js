'use strict'

const testConfigs = [
  {
    integration: 'cassandra-driver',
    repo: 'https://github.com/datastax/nodejs-driver',
    framework: 'mocha',
    args: '-R spec -t 5000 --recursive --exit test/unit'
  }
]

module.exports = testConfigs
