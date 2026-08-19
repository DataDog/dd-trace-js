'use strict'

const { execFileSync, execSync } = require('node:child_process')
const path = require('node:path')

const { FakeAgent, sandboxCwd, useSandbox } = require('../helpers')

const yarnPath = require.resolve('yarn/bin/yarn.js')

// This should switch to our withVersion helper. The order here currently matters.
const { ESBUILD_VERSION } = process.env
const esbuildVersions = ESBUILD_VERSION ? [ESBUILD_VERSION] : ['latest', '0.16.12']

esbuildVersions.forEach((version) => {
  describe('OpenFeature', () => {
    let agent, cwd

    useSandbox([`esbuild@${version}`, 'hono', '@hono/node-server'], false, [__dirname])

    before(() => {
      cwd = sandboxCwd()
      // Remove Bun's install output and reinstall with Yarn.
      // TODO add this in createSandbox if it's need in more places
      execSync(`rm -rf ${path.join(cwd, 'node_modules')}`, { cwd })
      execSync(`rm -rf ${path.join(cwd, 'bun.lock')}`, { cwd })

      execFileSync(process.execPath, [yarnPath, '--ignore-engines'], { cwd })
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(() => {
      agent.stop()
    })

    it('should not crash build after installing with yarn', () => {
      execSync('node esbuild/build.esm-hono-output-esm.mjs', { cwd })
    })
  })
})
