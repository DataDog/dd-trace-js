'use strict'

const defaultConfig = {
  integration: 'cassandra-driver',
  repo: 'https://github.com/datastax/nodejs-driver',
  testType: 'mocha',
  testArgs: 'test/unit -R spec -t 5000 --recursive'
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
