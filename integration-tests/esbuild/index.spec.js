#!/usr/bin/env node

/* eslint-disable no-console */

'use strict'

const chproc = require('child_process')
const pathModule = require('path')
const fs = require('fs')
// TODO: It shouldn't be necessary to disable n/no-extraneous-require - Research

const { assert } = require('chai')

// sub process must be executed inside TEST_DIR
const TEST_DIR = pathModule.join(__dirname, '.')
const execSync = (command, options) => chproc.execSync(command, { ...(options ?? {}), cwd: TEST_DIR })
const rmSync = (path, options) => fs.rmSync(pathModule.join(TEST_DIR, path), options)
const readFileSync = (path, options) => fs.readFileSync(pathModule.join(TEST_DIR, path), options)
const originalDir = process.cwd()

// This should switch to our withVersion helper. The order here currently matters.
const esbuildVersions = ['latest', '0.16.12']

esbuildVersions.forEach((version) => {
  describe(`esbuild ${version}`, () => {
    before(() => {
      process.chdir(TEST_DIR)
      execSync('npm install', {
        timeout: 1000 * 30
      })
      if (version === 'latest') {
        const versionsPackageJson = require('../../packages/dd-trace/test/plugins/versions/package.json')
        const version = versionsPackageJson.dependencies.esbuild
        execSync(`npm install esbuild@${version}`, {
          timeout: 1000 * 30
        })
      } else {
        execSync(`npm install esbuild@${version}`, {
          timeout: 1000 * 30
        })
      }
    })

    after(() => {
      process.chdir(originalDir)
    })

    it('works', () => {
      console.log('npm run build')
      execSync('npm run build')

      console.log('npm run built')
      try {
        execSync('npm run built', {
          timeout: 1000 * 30
        })
      } catch (err) {
        console.error(err)
        process.exit(1)
      } finally {
        rmSync('./out.js', { force: true })
      }
    })

    it('does not bundle modules listed in .external', () => {
      const command = 'node ./build-and-test-skip-external.js'
      console.log(command)
      execSync(command, {
        timeout: 1000 * 30
      })
    })

    it('handles typescript apps that import without file extensions', () => {
      const command = 'node ./build-and-test-typescript.mjs'
      console.log(command)
      execSync(command, {
        timeout: 1000 * 30
      })
    })

    it('handles the complex aws-sdk package with dynamic requires', () => {
      const command = 'node ./build-and-test-aws-sdk.js'
      console.log(command)
      execSync(command, {
        timeout: 1000 * 30
      })
    })

    it('handles scoped node_modules', () => {
      const command = 'node ./build-and-test-koa.mjs'
      console.log(command)
      execSync(command, {
        timeout: 1000 * 30
      })
    })

    it('handles instrumentations where the patching function is a property of the hook', () => {
      const command = 'node ./build-and-test-openai.js'
      console.log(command)
      execSync(command, {
        timeout: 1000 * 30
      })
    })

    it('injects Git metadata into bundled applications', () => {
      const command = 'node ./build-and-test-git-tags.js'
      console.log(command)
      execSync(command, {
        timeout: 1000 * 30
      })
    })

    describe('ESM', () => {
      afterEach(() => {
        rmSync('./out.mjs', { force: true })
        rmSync('./out.js', { force: true })
        rmSync('./basic-test.mjs', { force: true })
      })

      it('works', () => {
        console.log('npm run build:esm')
        execSync('npm run build:esm')
        console.log('npm run built:esm')
        execSync('npm run built:esm', {
          timeout: 1000 * 30
        })
      })

      it('should not override existing js banner', () => {
        const command = 'node ./build-and-run.esm-unrelated-js-banner.mjs'
        console.log(command)
        execSync(command, {
          timeout: 1000 * 30
        })

        const builtFile = readFileSync('./out.mjs').toString()
        assert.include(builtFile, '/* js test */')
      })

      it('should contain the definitions when esm is inferred from outfile', () => {
        const command = 'node ./build-and-run.esm-relying-in-extension.mjs'
        console.log(command)
        execSync(command, {
          timeout: 1000 * 30
        })

        const builtFile = readFileSync('./out.mjs').toString()
        assert.include(builtFile, 'globalThis.__filename ??= $dd_fileURLToPath(import.meta.url);')
      })

      it('should contain the definitions when esm is inferred from format', () => {
        const command = 'node ./build-and-run.esm-relying-in-format.mjs'
        console.log(command)
        execSync(command, {
          timeout: 1000 * 30
        })

        const builtFile = readFileSync('./out.mjs').toString()
        assert.include(builtFile, 'globalThis.__filename ??= $dd_fileURLToPath(import.meta.url);')
      })

      it('should contain the definitions when format is inferred from out extension', () => {
        const command = 'node ./build-and-run.esm-relying-in-out-extension.mjs'
        console.log(command)
        execSync(command, {
          timeout: 1000 * 30
        })

        const builtFile = readFileSync('./basic-test.mjs').toString()
        assert.include(builtFile, 'globalThis.__filename ??= $dd_fileURLToPath(import.meta.url);')
      })

      it('should not contain the definitions when no esm is specified', () => {
        const command = 'node ./build.js'
        console.log(command)
        execSync(command, {
          timeout: 1000 * 30
        })

        const builtFile = readFileSync('./out.js').toString()
        assert.notInclude(builtFile, 'globalThis.__filename ??= $dd_fileURLToPath(import.meta.url);')
      })

      it('should not crash when it is already patched using global', () => {
        const command = 'node ./build-and-run.esm-patched-global-banner.mjs'
        console.log(command)
        execSync(command, {
          timeout: 1000 * 30
        })
      })

      it('should not crash when it is already patched using const', () => {
        const command = 'node ./build-and-run.esm-patched-const-banner.mjs'
        console.log(command)
        execSync(command, {
          timeout: 1000 * 30
        })
      })
    })
  })
})
