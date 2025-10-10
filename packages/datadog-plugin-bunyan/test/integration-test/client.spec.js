'use strict'

const {
  FakeAgent,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { withVersions, insertVersionDep } = require('../../../dd-trace/test/setup/mocha')
const { expect } = require('chai')
const { join } = require('path')

describe('esm', () => {
  let agent
  let proc
  const env = {
    NODE_OPTIONS: `--loader=${join(__dirname, '..', '..', '..', '..', 'initialize.mjs')}`
  }

  withVersions('bunyan', 'bunyan', version => {
    insertVersionDep(__dirname, 'bunyan', version)

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })

    for (const variant of ['default', 'star', 'destructure']) {
      it(`is instrumented loaded with ${variant}`, async () => {
        proc = await spawnPluginIntegrationTestProc(
          __dirname,
          `server-${variant}.mjs`,
          agent.port,
          (data) => {
            const jsonObject = JSON.parse(data.toString())
            expect(jsonObject).to.have.property('dd')
          },
          env
        )
      }).timeout(20000)
    }
  })
})
