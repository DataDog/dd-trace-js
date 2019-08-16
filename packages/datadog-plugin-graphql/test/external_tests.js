'use strict'

const path = require('path')
const fs = require('fs')
const execSync = require('child_process').execSync

const testConfigs = [
  {
    integration: 'graphql',
    repo: 'https://github.com/graphql/graphql-js',
    framework: 'mocha',
    args: '--full-trace **/__tests__/**/*-test.js',
    setup: function (tracerSetupPath, options) {
      execSync('npm install', options)

      const cwd = options.cwd
      const srcDir = path.join(cwd, 'src')
      const srcFiles = fs.readdirSync(srcDir)

      // Move all the files in the 'src' dir to the parent directory
      for (let i = 0; i < srcFiles.length; ++i) {
        const oldPath = path.join(srcDir, srcFiles[i])
        const newPath = path.join(cwd, path.basename(oldPath))
        fs.renameSync(oldPath, newPath)
      }
    }
  }
]

module.exports = testConfigs
