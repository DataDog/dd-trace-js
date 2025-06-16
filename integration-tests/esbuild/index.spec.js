#!/usr/bin/env node

/* eslint-disable no-console */

'use strict'

const chproc = require('child_process')
const path = require('path')
const fs = require('fs')
const { assert } = require('chai')

const TEST_DIR = path.join(__dirname, '.')
process.chdir(TEST_DIR)

// This should switch to our withVersion helper. The order here currently matters.
const esbuildVersions = ['latest', '0.16.12']

esbuildVersions.forEach((version) => {
  describe(`esbuild ${version}`, () => {
    before(() => {
      chproc.execSync('npm install', {
        timeout: 1000 * 30
      })
      if (version !== 'latest') {
        chproc.execSync(`npm install esbuild@${version}`, {
          timeout: 1000 * 30
        })
      }
    })

    it('works', () => {
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
        fs.rmSync('./out.js', { force: true })
      }
    })

    it('does not bundle modules listed in .external', () => {
      const command = 'node ./build-and-test-skip-external.js'
      console.log(command)
      chproc.execSync(command, {
        timeout: 1000 * 30
      })
    })

    it('handles typescript apps that import without file extensions', () => {
      const command = 'node ./build-and-test-typescript.mjs'
      console.log(command)
      chproc.execSync(command, {
        timeout: 1000 * 30
      })
    })

    it('handles the complex aws-sdk package with dynamic requires', () => {
      const command = 'node ./build-and-test-aws-sdk.js'
      console.log(command)
      chproc.execSync(command, {
        timeout: 1000 * 30
      })
    })

    it('handles scoped node_modules', () => {
      const command = 'node ./build-and-test-koa.mjs'
      console.log(command)
      chproc.execSync(command, {
        timeout: 1000 * 30
      })
    })

    describe('ESM', () => {
      before(() => {
        console.log('npm run build:esm')
        chproc.execSync('npm run build:esm')
      })

      after(() => {
        fs.rmSync('./out.mjs', { force: true })
        fs.rmSync('./out-with-unrelated-js-banner.mjs', { force: true })
        fs.rmSync('./out-with-patched-global-banner.mjs', { force: true })
        fs.rmSync('./out-with-patched-const-banner.mjs', { force: true })
      })

      it('works', () => {
        console.log('npm run built')
        chproc.execSync('npm run built:esm', {
          timeout: 1000 * 30
        })
      })

      it('should not override existing js banner', () => {
        const builtFile = fs.readFileSync('./out-with-unrelated-js-banner.mjs').toString()
        assert.include(builtFile, '/* js test */')
      })

      it('should not crash when it is already patched using global', () => {
        chproc.execSync('DD_TRACE_DEBUG=true node out-with-patched-global-banner.mjs', {
          timeout: 1000 * 30
        })
      })

      it('should not crash when it is already patched using const', () => {
        chproc.execSync('DD_TRACE_DEBUG=true node out-with-patched-const-banner.mjs', {
          timeout: 1000 * 30
        })
      })
    })
  })
})
