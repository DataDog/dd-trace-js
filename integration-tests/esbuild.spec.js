#!/usr/bin/env node

'use strict'

const chproc = require('child_process')
const path = require('path')

const TEST_DIR = path.join(__dirname, 'esbuild')

// eslint-disable-next-line no-console
console.log(`cd ${TEST_DIR}`)
process.chdir(TEST_DIR)

// eslint-disable-next-line no-console
console.log('npm run build')
chproc.execSync('npm run build')

// eslint-disable-next-line no-console
console.log('npm run built')
chproc.execSync('npm run built', {
  timeout: 1000 * 30
})
