'use strict'

const { execSync } = require('node:child_process')
const path = require('node:path')

const { FakeAgent, createSandbox } = require('../helpers')

// This should switch to our withVersion helper. The order here currently matters.
const esbuildVersions = ['latest', '0.16.12']

esbuildVersions.forEach((version) => {
  describe('OpenFeature', () => {
    let sandbox, agent, cwd

    before(async () => {
      sandbox = await createSandbox([`esbuild@${version}`, 'hono', '@hono/node-server'], false, [__dirname])
      cwd = sandbox.folder
      // remove all node_modules and bun.lock file and install with yarn
      // TODO add this in createSandbox if it's need in more places
      execSync(`rm -rf ${path.join(cwd, 'node_modules')}`, { cwd })
      execSync(`rm -rf ${path.join(cwd, 'bun.lock')}`, { cwd })
      execSync('npm install -g yarn', { cwd })

      execSync('yarn', { cwd })
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    after(() => {
      sandbox.remove()
    })

    afterEach(() => {
      agent.stop()
    })

    it('should not crash build after installing with yarn', () => {
      execSync('node esbuild/build.esm-hono-output-esm.mjs', { cwd })
    })
  })
})
