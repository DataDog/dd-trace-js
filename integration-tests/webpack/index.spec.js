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
const rmSync = (path, options) => fs.rmSync(pathModule.join(TEST_DIR, path), options)
const originalDir = process.cwd()

const timeout = 1000 * 60

describe('webpack 5', function () {
  this.timeout(timeout)

  before(() => {
    process.chdir(TEST_DIR)
    execSync('npm install', { timeout })
    execSync('npm install webpack@5 webpack-cli@5', { timeout })
  })

  after(() => {
    process.chdir(originalDir)
    execSync('npm remove webpack webpack-cli', { timeout })
    rmSync('./dist', { force: true, recursive: true })
  })

  it('works', () => {
    execSync('npm run build')

    try {
      execSync('npm run built', { timeout })
    } catch (err) {
      console.error(err)
      process.exit(1)
    } finally {
      rmSync('./dist', { force: true, recursive: true })
    }
  })
})
