#!/usr/bin/env node

/* eslint-disable no-console */

'use strict'

const chproc = require('node:child_process')
const pathModule = require('node:path')
const fs = require('node:fs')

const { describe, before, after, it } = require('mocha')

// sub process must be executed inside TEST_DIR
const TEST_DIR = pathModule.join(__dirname, '.')
const execSync = (command, options) => {
  console.log(command)
  chproc.execSync(command, { ...(options ?? {}), cwd: TEST_DIR })
}
const rmSync = (filePath, options) => fs.rmSync(pathModule.join(TEST_DIR, filePath), options)
const originalDir = process.cwd()

// Test with two webpack 5 versions: an older one and the latest
// Note: webpack 5.0.0 hardcodes "md4" in FileSystemInfo, incompatible with
// OpenSSL 3 (Node 18+). 5.54.0 is the first version where FileSystemInfo
// reads output.hashFunction, allowing sha256 to be used instead.
const webpackVersions = ['5.54.0', '5']
const timeout = 1000 * 60

webpackVersions.forEach((version) => {
  describe(`webpack ${version}`, function () {
    this.timeout(timeout)

    before(() => {
      process.chdir(TEST_DIR)
      execSync('npm install', { timeout })
      execSync(`npm install webpack@${version}`, { timeout })
    })

    after(() => {
      process.chdir(originalDir)
      execSync('npm remove webpack', { timeout })
    })

    it('works', () => {
      execSync('npm run build', { timeout })

      try {
        execSync('npm run built', { timeout })
      } catch (err) {
        console.error(err)
        process.exit(1)
      } finally {
        rmSync('./out.js', { force: true })
      }
    })

    it('does not bundle modules listed in externals', () => {
      execSync('node ./build-and-test-skip-external.js', { timeout })
    })

    it('injects Git metadata into bundled applications', () => {
      execSync('node ./build-and-test-git-tags.js', { timeout })
    })

    it('prints error when user enables optimization.minimize', () => {
      execSync('node ./build-and-test-minify.js', { timeout })
    })
  })
})
