'use strict'

/* eslint-disable no-console */

const execSync = require('child_process').execSync
const { INIT_CWD, PWD } = process.env

// skip for local development or very old package managers without INIT_CWD
if (INIT_CWD && !INIT_CWD.includes(PWD)) {
  execSync('npm run install:rebuild --silent --scripts-prepend-node-path', { stdio: [0, 1, 2] })
}
