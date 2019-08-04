'use strict'

const defaultConfig = {
  integration: 'hapi',
  repo: 'https://github.com/hapijs/hapi',
  testType: 'lab',
  testArgs: '-a @hapi/code -m 3000 test/'
}

const testConfigs = [
  {
    branch: 'v16-commercial',
    testArgs: '-a code -m 3000 -l test/'
  },
  {
    branch: 'v17'
  },
  {
    branch: 'v18-commercial'
  }
]

module.exports = {
  defaultConfig,
  testConfigs
}
