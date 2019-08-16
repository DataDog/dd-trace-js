'use strict'

const testConfigs = [
  {
    integration: 'router',
    repo: 'https://github.com/pillarjs/router',
    framework: 'mocha',
    args: '--reporter spec --exit --check-leaks test/'
  }
]

module.exports = testConfigs
