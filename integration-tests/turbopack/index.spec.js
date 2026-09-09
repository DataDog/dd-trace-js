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
      this.timeout(300_000)
      applicationDirectory = path.join(sandboxCwd(), 'turbopack')
      const wrapperDirectory = path.join(sandboxCwd(), 'node_modules/foreign-ai-wrapper')
      fs.mkdirSync(wrapperDirectory)
      fs.writeFileSync(path.join(wrapperDirectory, 'package.json'), JSON.stringify({
        exports: './index.js',
        name: 'foreign-ai-wrapper',
        type: 'module',
        version: '1.0.0',
      }))
      fs.writeFileSync(path.join(wrapperDirectory, 'index.js'), [
        "import { generateText } from 'ai'",
        'export function wrappedGenerateText (options) { return generateText(options) }',
        '',
      ].join('\n'))
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

    it('runs bundled CommonJS and ESM dependencies', async () => {
      const assertCjsTrace = agent.assertMessageReceived(({ payload }) => {
        assert.strictEqual(checkSpansForServiceName(payload, 'next.request'), true)
        assert.strictEqual(checkSpansForServiceName(payload, 'express.request'), true)
        assert.strictEqual(checkSpansForServiceName(payload, 'generateText'), true)
      }, 10_000, 1, true)

      const [response] = await Promise.all([
        axios.get(`${proc.url}/api/cjs`),
        assertCjsTrace,
      ])
      assert.deepStrictEqual(response.data, { dependency: 'express', text: 'ok' })

      const assertEsmTrace = agent.assertMessageReceived(({ payload }) => {
        assert.strictEqual(checkSpansForServiceName(payload, 'next.request'), true)
        assert.strictEqual(checkSpansForServiceName(payload, 'generateText'), true)
      }, 10_000, 1, true)

      const [esmResponse] = await Promise.all([
        axios.get(`${proc.url}/api/esm`),
        assertEsmTrace,
      ])
      assert.deepStrictEqual(esmResponse.data, { dependency: 'foreign-ai-wrapper', text: 'ok' })
    })
  })
}
