'use strict'

const assert = require('node:assert')
const path = require('node:path')
const Axios = require('axios')
const { assertObjectContains, FakeAgent, spawnProc, sandboxCwd, useSandbox } = require('./helpers')

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
        // NYC rewrites the compiled JS which breaks --enable-source-maps resolution
        // back to typescript.ts, so opt the child out of the coverage harness.
        DD_TRACE_INTEGRATION_COVERAGE_DISABLE: '1',
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
          assert.ok(span.meta['_dd.code_origin.frames.0.file'].endsWith(`${cwd}/code-origin/typescript.ts`))
          assertObjectContains(span, {
            meta: {
              '_dd.code_origin.type': 'entry',
              '_dd.code_origin.frames.0.line': '10',
              '_dd.code_origin.frames.0.column': '5',
              '_dd.code_origin.frames.0.method': '<anonymous>',
              '_dd.code_origin.frames.0.type': 'Object',
            },
          })
        }, 2_500),
        await axios.get('/'),
      ])
    })
  })
})
