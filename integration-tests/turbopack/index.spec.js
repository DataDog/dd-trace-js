'use strict'

const assert = require('node:assert/strict')
const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const axios = require('axios')

const {
  FakeAgent,
  checkSpansForServiceName,
  sandboxCwd,
  spawnPluginIntegrationTestProc,
  stopProc,
  useSandbox,
} = require('../helpers')

for (const nextVersion of ['15.5.0', 'latest']) {
  describe(`Turbopack integration with Next.js ${nextVersion}`, () => {
    useSandbox([
      `next@${nextVersion}`,
      '@types/node',
      '@types/react@19.2.18',
      '@types/react-dom@19.2.7',
      'ai',
      'express',
      'react',
      'react-dom',
      'typescript@6.0.3',
    ], false, [__dirname])

    let agent
    let applicationDirectory
    let proc

    before(function () {
      this.timeout(60_000)
      applicationDirectory = path.join(sandboxCwd(), 'turbopack')
      fs.cpSync(
        path.join(applicationDirectory, 'fixtures/ioredis'),
        path.join(sandboxCwd(), 'node_modules/ioredis'),
        { recursive: true }
      )
      execSync('npm exec -- tsc --project tsconfig.json', { cwd: applicationDirectory, stdio: 'inherit' })
      execSync('npm exec -- next build --turbopack', { cwd: applicationDirectory, stdio: 'inherit' })
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
      proc = await spawnPluginIntegrationTestProc(applicationDirectory, 'server.js', agent.port, {
        NODE_OPTIONS: '--import=dd-trace/init.js',
      })
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    it('instruments bundled CommonJS, ESM, and extensionless dependencies', async () => {
      const assertCommonJsTrace = agent.assertMessageReceived(({ payload }) => {
        assert.strictEqual(checkSpansForServiceName(payload, 'next.request'), true)
        assert.strictEqual(checkSpansForServiceName(payload, 'express.request'), true)
        assert.strictEqual(checkSpansForServiceName(payload, 'redis.command'), true)
      }, 10_000, 1, true)

      const [response] = await Promise.all([
        axios.get(`${proc.url}/api/cjs`),
        assertCommonJsTrace,
      ])
      assert.deepStrictEqual(response.data, { value: 'extensionless' })

      const assertEsmTrace = agent.assertMessageReceived(({ payload }) => {
        assert.strictEqual(checkSpansForServiceName(payload, 'next.request'), true)
        assert.strictEqual(checkSpansForServiceName(payload, 'generateText'), true)
      }, 10_000, 1, true)

      const [esmResponse] = await Promise.all([
        axios.get(`${proc.url}/api/esm`),
        assertEsmTrace,
      ])
      assert.deepStrictEqual(esmResponse.data, { text: 'ok' })
    })
  })
}
