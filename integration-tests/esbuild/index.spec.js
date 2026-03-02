#!/usr/bin/env node

/* eslint-disable no-console */

'use strict'

const assert = require('node:assert/strict')
const chproc = require('node:child_process')
const pathModule = require('node:path')
const fs = require('node:fs')

const { describe, before, it } = require('mocha')

// sub process must be executed inside TEST_DIR
const TEST_DIR = pathModule.join(__dirname, '.')
const execSync = (command, options) => {
  console.log(command)
  chproc.execSync(command, { ...(options ?? {}), cwd: TEST_DIR })
}
const rmSync = (path, options) => fs.rmSync(pathModule.join(TEST_DIR, path), options)
const readFileSync = (path, options) => fs.readFileSync(pathModule.join(TEST_DIR, path), options)
const originalDir = process.cwd()

const versionsPackageJson = require('../../packages/dd-trace/test/plugins/versions/package.json')
const maximumEsbuildVersion = versionsPackageJson.dependencies.esbuild

// This should switch to our withVersion helper. The order here currently matters.
const esbuildVersions = ['0.16.12', maximumEsbuildVersion]
const timeout = 1000 * 45

esbuildVersions.forEach((version) => {
  describe(`esbuild ${version}`, function () {
    this.timeout(timeout)

    before(() => {
      process.chdir(TEST_DIR)
      execSync('npm install', {
        timeout,
      })
      execSync(`npm install esbuild@${version}`, {
        timeout,
      })
    })

    after(() => {
      process.chdir(originalDir)
      execSync('npm remove esbuild', {
        timeout,
      })
    })

    it('works', () => {
      execSync('npm run build')

      try {
        execSync('npm run built', {
          timeout,
        })
      } catch (err) {
        console.error(err)
        process.exit(1)
      } finally {
        rmSync('./out.js', { force: true })
        rmSync('./dd-trace-debugger-worker.cjs', { force: true })
      }
    })

    it('does not bundle modules listed in .external', () => {
      execSync('node ./build-and-test-skip-external.js', {
        timeout,
      })
    })

    it('handles typescript apps that import without file extensions', () => {
      execSync('node ./build-and-test-typescript.mjs', {
        timeout,
      })
    })

    it('handles the complex aws-sdk package with dynamic requires', () => {
      execSync('node ./build-and-test-aws-sdk.js', {
        timeout,
      })
    })

    it('handles scoped node_modules', () => {
      execSync('node ./build-and-test-koa.mjs', {
        timeout,
      })
    })

    it('handles instrumentations where the patching function is a property of the hook', () => {
      execSync('node ./build-and-test-openai.js', {
        timeout,
      })
    })

    it('injects Git metadata into bundled applications', () => {
      execSync('node ./build-and-test-git-tags.js', {
        timeout,
      })
    })

    it('prints a warning when user opts to minify output without retaining class names', () => {
      execSync('node ./build-and-test-minify.js', {
        timeout,
      })
    })

    it('emits debugger worker bundle and allows LD/DI-enabled startup', () => {
      execSync('node ./build-and-test-debugger-worker.js', {
        timeout,
      })
    })

    describe('ESM', () => {
      afterEach(() => {
        rmSync('./out.mjs', { force: true })
        rmSync('./out.js', { force: true })
        rmSync('./basic-test.mjs', { force: true })
        rmSync('./dd-trace-debugger-worker.cjs', { force: true })
      })

      it('works', () => {
        execSync('npm run build:esm')
        execSync('npm run built:esm', {
          timeout,
        })
      })

      it('should not override existing js banner', () => {
        execSync('node ./build-and-run.esm-unrelated-js-banner.mjs', {
          timeout,
        })

        const builtFile = readFileSync('./out.mjs').toString()
        assert.match(builtFile, /\/\* js test \*\//m)
      })

      it('should contain the definitions when esm is inferred from outfile', () => {
        execSync('node ./build-and-run.esm-relying-in-extension.mjs', {
          timeout,
        })

        const builtFile = readFileSync('./out.mjs').toString()
        assert.match(builtFile, /globalThis\.__filename \?\?= \$dd_fileURLToPath\(import\.meta\.url\);/m)
      })

      it('should contain the definitions when esm is inferred from format', () => {
        execSync('node ./build-and-run.esm-relying-in-format.mjs', {
          timeout,
        })

        const builtFile = readFileSync('./out.mjs').toString()
        assert.match(builtFile, /globalThis\.__filename \?\?= \$dd_fileURLToPath\(import\.meta\.url\);/m)
      })

      it('should contain the definitions when format is inferred from out extension', () => {
        execSync('node ./build-and-run.esm-relying-in-out-extension.mjs', {
          timeout,
        })

        const builtFile = readFileSync('./basic-test.mjs').toString()
        assert.match(builtFile, /globalThis\.__filename \?\?= \$dd_fileURLToPath\(import\.meta\.url\);/m)
      })

      it('should not contain the definitions when no esm is specified', () => {
        execSync('node ./build.js', {
          timeout,
        })

        const builtFile = readFileSync('./out.js').toString()
        assert.doesNotMatch(builtFile, /globalThis\.__filename \?\?= \$dd_fileURLToPath\(import\.meta\.url\);/m)
      })

      it('should not crash when it is already patched using global', () => {
        execSync('node ./build-and-run.esm-patched-global-banner.mjs', {
          timeout,
        })
      })

      it('should not crash when it is already patched using const', () => {
        execSync('node ./build-and-run.esm-patched-const-banner.mjs', {
          timeout,
        })
      })
    })
  })
})
