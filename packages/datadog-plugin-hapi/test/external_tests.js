'use strict'

const execSync = require('child_process').execSync

const defaultConfig = {
  integration: 'hapi',
  repo: 'https://github.com/hapijs/hapi',
  testType: 'lab',
  testArgs: '-a @hapi/code -m 3000 test/',
  setup: function (cwd) {
    execSync('npm install', { cwd })
  }
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
