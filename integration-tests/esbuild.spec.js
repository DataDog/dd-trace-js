#!/usr/bin/env node

'use strict'

const chproc = require('child_process')
const path = require('path')

const CWD = process.cwd()
const TEST_DIR = path.join(__dirname, 'esbuild')
const DD_DIR = path.join(__dirname, '..')

console.log(`cd ${DD_DIR}`)
process.chdir(DD_DIR)

console.log('yarn link')
chproc.execSync('yarn link')

console.log(`cd ${CWD}`)
process.chdir(CWD)

console.log('yarn link dd-trace')
chproc.execSync('yarn link dd-trace')

console.log('npm run build')
chproc.execSync('npm run build')

// eslint-disable-next-line no-console
console.log(`cd ${TEST_DIR}`)
process.chdir(TEST_DIR)

// eslint-disable-next-line no-console
console.log('npm run build')
chproc.execSync('npm run build')

// eslint-disable-next-line no-console
console.log('npm run built')
try {
  chproc.execSync('npm run built', {
    timeout: 1000 * 30
  })
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
} finally {
  process.chdir(CWD)
}
