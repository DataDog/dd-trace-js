'use strict'

const execSync = require('child_process').execSync

const defaultConfig = {
  integration: 'koa',
  repo: 'https://github.com/koajs/koa',
  testType: 'jest',
  testArgs: '--config jestconfig.json',
  setup: function (cwd) {
    return execSync('npm install && npm install jest@24.8 --save-deps && npm install module-details-from-path --save-deps', { cwd })
  }
}

const testConfigs = []

module.exports = {
  defaultConfig,
  testConfigs
}
