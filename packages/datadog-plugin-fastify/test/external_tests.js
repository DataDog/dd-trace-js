'use strict'

const execSync = require('child_process').execSync

const defaultConfig = {
  integration: 'fastify',
  repo: 'https://github.com/fastify/fastify',
  testType: 'tap',
  testArgs: '--no-esm -J test/*.test.js test/*/*.test.js',
  setup: function (cwd) {
    execSync('npm install', { cwd })
  }
}

const testConfigs = [
  {
    branch: '1.x'
  },
  {
    branch: undefined
  }
]

module.exports = {
  defaultConfig,
  testConfigs
}
