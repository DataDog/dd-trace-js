#!/usr/bin/env node

'use strict'

const chproc = require('child_process')
const path = require('path')

const CWD = process.cwd()
const TEST_DIR = path.join(__dirname, 'esbuild')

describe('esbuild', () => {
  it('works', () => {
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
  })

  it('does not bundle modules listed in .external', () => {
    // eslint-disable-next-line no-console
    console.log(`cd ${TEST_DIR}`)
    process.chdir(TEST_DIR)

    try {
      // eslint-disable-next-line no-console
      console.log('node ./build-and-test-skip-external.js')
      chproc.execSync('node ./build-and-test-skip-external.js', {
        timeout: 1000 * 30
      })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(err)
      process.exit(1)
    } finally {
      process.chdir(CWD)
    }
  })

  it('handles typescript apps that import without file extensions', () => {
    // eslint-disable-next-line no-console
    console.log(`cd ${TEST_DIR}`)
    process.chdir(TEST_DIR)

    try {
      // eslint-disable-next-line no-console
      console.log('node ./build-and-test-typescript.mjs')
      chproc.execSync('node ./build-and-test-typescript.mjs', {
        timeout: 1000 * 30
      })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(err)
      process.exit(1)
    } finally {
      process.chdir(CWD)
    }
  })
})
