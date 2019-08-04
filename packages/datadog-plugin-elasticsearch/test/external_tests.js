'use strict'

const defaultConfig = {
  integration: '@elastic/elasticsearch',
  repo: 'https://github.com/elastic/elasticsearch-js',
  testType: 'tap',
  testArgs: 'test/unit/*.test.js test/behavior/*.test.js test/integration/index.js -t 300 --no-coverage'
}

const testConfigs = [
  {
    integration: 'elasticsearch',
    repo: 'https://github.com/elastic/elasticsearch-js-legacy',
    testType: 'mocha',
    testArgs: 'test/unit/index.js'
  },
  {
    branch: '5.x'
  },
  {
    branch: '6.x'
  },
  {
    branch: '7.x'
  }
]

module.exports = {
  defaultConfig,
  testConfigs
}
