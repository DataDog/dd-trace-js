'use strict'

const path = require('path')
const fs = require('fs')
const execSync = require('child_process').execSync

const defaultConfig = {
  integration: 'promise-js',
  repo: 'https://github.com/kevincennis/promise',
  testType: 'promises-aplus-tests',
  testArgs: 'test/adapter.js',
  setup: function (cwd) {
    execSync('npm install', { cwd })

    const distDir = path.join(cwd, 'dist')
    if (!fs.existsSync(distDir)) {
      fs.mkdirSync(distDir)
    }

    const promiseTestSrc = path.join(distDir, 'promise.min.js')
    if (!fs.existsSync(promiseTestSrc)) {
      const promiseSrc = path.join(cwd, 'promise.js')
      fs.symlinkSync(promiseSrc, promiseTestSrc, 'file')
    }
  }
}

module.exports = {
  defaultConfig
}
