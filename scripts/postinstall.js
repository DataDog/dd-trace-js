'use strict'

/* eslint-disable no-console */

const execSync = require('child_process').execSync

if (__dirname.indexOf('/node_modules/') !== -1) {
  execSync('npm run install:rebuild --silent --scripts-prepend-node-path', { stdio: [0, 1, 2] })
}
