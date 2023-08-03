#!/usr/bin/env node

/* eslint-disable no-console */

'use strict'

const chproc = require('child_process')
const path = require('path')

const CWD = process.cwd()
const TEST_DIR = path.join(__dirname, 'esbuild')
const DD_DIR = path.join(__dirname, '..')

console.log(`cd ${DD_DIR}`)
process.chdir(DD_DIR)

// yarn link is required as the injected bundle code now references dd-trace
console.log('yarn link')
chproc.execSync('yarn link')

describe('esbuild', () => {
  it('works', () => {
    console.log(`cd ${TEST_DIR}`)
    process.chdir(TEST_DIR)

    console.log('yarn link dd-trace')
    chproc.execSync('yarn link dd-trace')

    console.log('npm run build')
    chproc.execSync('npm run build')

    try {
      console.log('npm run built')
      chproc.execSync('npm run built', {
        timeout: 1000 * 30
      })
    } catch (err) {
      console.error(err)
      process.exit(1)
    } finally {
      process.chdir(CWD)
    }
  })

  it('does not bundle modules listed in .external', () => {
    console.log(`cd ${TEST_DIR}`)
    process.chdir(TEST_DIR)

    console.log('yarn link dd-trace')
    chproc.execSync('yarn link dd-trace')

    try {
      console.log('node ./build-and-test-skip-external.js')
      chproc.execSync('node ./build-and-test-skip-external.js', {
        timeout: 1000 * 30
      })
    } catch (err) {
      console.error(err)
      process.exit(1)
    } finally {
      process.chdir(CWD)
    }
  })
})
