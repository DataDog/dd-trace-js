#!/usr/bin/env node

/* eslint-disable no-console */

'use strict'

const assert = require('node:assert/strict')
const chproc = require('node:child_process')
const pathModule = require('node:path')
const fs = require('node:fs')

const axios = require('axios')

const { describe, before, after, it } = require('mocha')

const { FakeAgent, spawnProc, stopProc } = require('../helpers')

// sub process must be executed inside TEST_DIR
const TEST_DIR = pathModule.join(__dirname, '.')
const execSync = (command, options) => {
  console.log(command)
  chproc.execSync(command, { ...(options ?? {}), cwd: TEST_DIR })
}

/**
 * @param {{ payload: Array<Array<{ name: string, type: string }>> }} message
 */
function assertHonoTrace ({ payload }) {
  for (const trace of payload) {
    for (const span of trace) {
      if (span.type !== 'web') continue
      assert.strictEqual(span.name, 'hono.request')
      return
    }
  }
  assert.fail('web span not found')
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

    it('instruments an ESM package in the bundle', async () => {
      execSync('node ./fixtures/build-esm.mjs', { timeout })

      const agent = await new FakeAgent().start()
      let proc
      try {
        proc = await spawnProc(pathModule.join(TEST_DIR, 'hono-out.cjs'), {
          cwd: TEST_DIR,
          env: { DD_TRACE_AGENT_URL: `http://localhost:${agent.port}` },
          stdio: 'pipe',
        })

        await Promise.all([
          agent.assertMessageReceived(assertHonoTrace, 2_500),
          axios.get(proc.url),
        ])
      } finally {
        try {
          await stopProc(proc)
        } finally {
          await agent.stop()
          rmSync('./hono-out.cjs', { force: true })
        }
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
