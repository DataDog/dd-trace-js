'use strict'

const assert = require('node:assert')
const Module = require('node:module')
const path = require('node:path')
const Axios = require('axios')
const { assertObjectContains, FakeAgent, spawnProc, sandboxCwd, useSandbox } = require('./helpers')

// eslint-disable-next-line n/no-unsupported-features/node-builtins
const supportsProgrammaticSourceMaps = typeof Module.setSourceMapsSupport === 'function'

describe('Code Origin for Spans', function () {
  let cwd, appFile, agent, proc, axios

  useSandbox(['fastify'])

  before(() => {
    cwd = sandboxCwd()
    appFile = path.join(cwd, 'code-origin', 'index.js')
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
    proc = await spawnProc(appFile, {
      cwd,
      env: {
        // Opt out: NYC's transform breaks source-map resolution to the .ts source.
        _DD_TRACE_INTEGRATION_COVERAGE_DISABLE: '1',
        // Older runtimes cannot enable parsing before the compiled module is loaded.
        ...(supportsProgrammaticSourceMaps ? {} : { NODE_OPTIONS: '--enable-source-maps' }),
        DD_TRACE_AGENT_URL: `http://localhost:${agent.port}`,
        DD_TRACE_FLUSH_INTERVAL: '0',
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
          // Switch to `assert.match(span.meta[...], new RegExp(`${RegExp.escape(cwd)}/code-origin/typescript\\.ts$`))`
          // once the minimum supported Node.js version is 24. Until then, `RegExp.escape` is unavailable and
          // hand-escaping every regex metacharacter in `cwd` would be more error-prone than this `endsWith` check.
          // eslint-disable-next-line eslint-rules/eslint-prefer-assert-match
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
        }),
        axios.get('/'),
      ])
    })
  })
})
