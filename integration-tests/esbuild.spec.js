#!/usr/bin/env node

/* eslint-disable no-console */

'use strict'

const chproc = require('child_process')
const path = require('path')

const CWD = process.cwd()
const TEST_DIR = path.join(__dirname, 'esbuild')

describe('esbuild', () => {
  it('works', () => {
    console.log(`cd ${TEST_DIR}`)
    process.chdir(TEST_DIR)

    console.log('npm run build')
    chproc.execSync('npm run build')

    console.log('npm run built')
    try {
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

  it('handles typescript apps that import without file extensions', () => {
    console.log(`cd ${TEST_DIR}`)
    process.chdir(TEST_DIR)

    try {
      console.log('node ./build-and-test-typescript.mjs')
      chproc.execSync('node ./build-and-test-typescript.mjs', {
        timeout: 1000 * 30
      })
    } catch (err) {
      console.error(err)
      process.exit(1)
    } finally {
      process.chdir(CWD)
    }
  })

  it('handles the complex aws-sdk package with dynamic requires', () => {
    console.log(`cd ${TEST_DIR}`)
    process.chdir(TEST_DIR)

    try {
      console.log('node ./build-and-test-aws-sdk.js')
      chproc.execSync('node ./build-and-test-aws-sdk.js', {
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
