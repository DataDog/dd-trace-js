'use strict'

const path = require('path')
const fs = require('fs')
const execSync = require('child_process').execSync

const defaultConfig = {
  integration: 'graphql',
  repo: 'https://github.com/graphql/graphql-js',
  testType: 'mocha',
  testArgs: '--full-trace **/__tests__/**/*-test.js',
  setup: function (cwd) {
    execSync('npm install', { cwd })

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

module.exports = {
  defaultConfig
}
