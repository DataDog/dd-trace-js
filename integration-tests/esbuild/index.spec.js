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
      afterEach(() => {
        fs.rmSync('./out.mjs', { force: true })
        fs.rmSync('./out.js', { force: true })
        fs.rmSync('./basic-test.mjs', { force: true })
      })

      it('works', () => {
        console.log('npm run build:esm')
        chproc.execSync('npm run build:esm')
        console.log('npm run built:esm')
        chproc.execSync('npm run built:esm', {
          timeout: 1000 * 30
        })
      })

      it('should not override existing js banner', () => {
        const command = 'node ./build-and-run.esm-unrelated-js-banner.mjs'
        console.log(command)
        chproc.execSync(command, {
          timeout: 1000 * 30
        })

        const builtFile = fs.readFileSync('./out.mjs').toString()
        assert.include(builtFile, '/* js test */')
      })

      it('should contain the definitions when esm is inferred from outfile', () => {
        const command = 'node ./build-and-run.esm-relying-in-extension.mjs'
        console.log(command)
        chproc.execSync(command, {
          timeout: 1000 * 30
        })

        const builtFile = fs.readFileSync('./out.mjs').toString()
        assert.include(builtFile, 'globalThis.__filename ??= $dd_fileURLToPath(import.meta.url);')
      })

      it('should contain the definitions when esm is inferred from format', () => {
        const command = 'node ./build-and-run.esm-relying-in-format.mjs'
        console.log(command)
        chproc.execSync(command, {
          timeout: 1000 * 30
        })

        const builtFile = fs.readFileSync('./out.mjs').toString()
        assert.include(builtFile, 'globalThis.__filename ??= $dd_fileURLToPath(import.meta.url);')
      })

      it('should contain the definitions when format is inferred from out extension', () => {
        const command = 'node ./build-and-run.esm-relying-in-out-extension.mjs'
        console.log(command)
        chproc.execSync(command, {
          timeout: 1000 * 30
        })

        const builtFile = fs.readFileSync('./basic-test.mjs').toString()
        assert.include(builtFile, 'globalThis.__filename ??= $dd_fileURLToPath(import.meta.url);')
      })

      it('should not contain the definitions when no esm is specified', () => {
        const command = 'node ./build.js'
        console.log(command)
        chproc.execSync(command, {
          timeout: 1000 * 30
        })

        const builtFile = fs.readFileSync('./out.js').toString()
        assert.notInclude(builtFile, 'globalThis.__filename ??= $dd_fileURLToPath(import.meta.url);')
      })

      it('should not crash when it is already patched using global', () => {
        const command = 'node ./build-and-run.esm-patched-global-banner.mjs'
        console.log(command)
        chproc.execSync(command, {
          timeout: 1000 * 30
        })
      })

      it('should not crash when it is already patched using const', () => {
        const command = 'node ./build-and-run.esm-patched-const-banner.mjs'
        console.log(command)
        chproc.execSync(command, {
          timeout: 1000 * 30
        })
      })
    })
  })
})
