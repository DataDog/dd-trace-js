'use strict'

const defaultConfig = {
  integration: 'fastify',
  repo: 'https://github.com/fastify/fastify',
  testType: 'tap',
  testArgs: '--no-esm -J test/*.test.js test/*/*.test.js'
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
