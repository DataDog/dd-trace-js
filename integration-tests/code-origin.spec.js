'use strict'

const assert = require('node:assert')
const path = require('node:path')
const Axios = require('axios')
const { FakeAgent, spawnProc, sandboxCwd, useSandbox } = require('./helpers')

describe('Code Origin for Spans', function () {
  let cwd, appFile, agent, proc, axios

  useSandbox(['fastify'])

  before(() => {
    cwd = sandboxCwd()
    appFile = path.join(cwd, 'code-origin', 'typescript.js')
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
    proc = await spawnProc(appFile, {
      cwd,
      env: {
        NODE_OPTIONS: '--enable-source-maps',
        DD_TRACE_AGENT_URL: `http://localhost:${agent.port}`,
      },
      stdio: 'pipe',
    })
    axios = Axios.create({ baseURL: proc.url })
  })

  afterEach(async () => {
    proc?.kill()
    await agent?.stop()
  })

  describe('source map support', function () {
    it('should support source maps', async () => {
      await Promise.all([
        agent.assertMessageReceived(({ payload }) => {
          const [span] = payload.flatMap(p => p.filter(span => span.name === 'fastify.request'))
          assert.strictEqual(span.meta['_dd.code_origin.type'], 'entry')
          assert.ok(span.meta['_dd.code_origin.frames.0.file'].endsWith(`${cwd}/code-origin/typescript.ts`))
          assert.strictEqual(span.meta['_dd.code_origin.frames.0.line'], '10')
          assert.strictEqual(span.meta['_dd.code_origin.frames.0.column'], '5')
          assert.strictEqual(span.meta['_dd.code_origin.frames.0.method'], '<anonymous>')
          assert.strictEqual(span.meta['_dd.code_origin.frames.0.type'], 'Object')
        }, 2_500),
        await axios.get('/'),
      ])
    })
  })
})
