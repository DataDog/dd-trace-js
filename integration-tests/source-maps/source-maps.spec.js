'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const Axios = require('axios')
const satisfies = require('semifies')
const { FakeAgent, spawnProc, sandboxCwd, useSandbox, stopProc } = require('../helpers')

// `DD_TRACE_SOURCE_MAPS_ENABLED` relies on `module.setSourceMapsSupport()`, added in Node 22.14/23.7.
// This test deliberately does not pass `--enable-source-maps` — the point is flagless mapping — so
// on older runtimes there is nothing to assert.
const describeOrSkip = satisfies(process.versions.node, '>=22.14.0') ? describe : describe.skip

describeOrSkip('source map support (APM, no --enable-source-maps)', function () {
  let axios, cwd, appFile, agent, proc

  // `throws.js` / `throws.js.map` are committed (built from `throws.ts` via scripts/build-typescript.sh),
  // mirroring integration-tests/code-origin. Compiling in-test is fragile: newer TypeScript rejects the
  // committed tsconfig, and `.mocharc.js` runs with `allowUncaught`, so a throwing `before` silently
  // drops the whole suite instead of failing.
  useSandbox(['fastify'])

  before(function () {
    cwd = sandboxCwd()
    // The entry preloads dd-trace, then requires the compiled app; see index.js for why.
    appFile = path.join(cwd, 'source-maps', 'index.js')
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
    proc = await spawnProc(appFile, {
      cwd,
      env: {
        // NYC's instrumentation of the spawned app rewrites its source maps; disable it so the
        // .ts source resolves (matches integration-tests/code-origin.spec.js).
        _DD_TRACE_INTEGRATION_COVERAGE_DISABLE: '1',
        DD_TRACE_AGENT_URL: `http://localhost:${agent.port}`,
      },
      stdio: 'pipe',
    })
    axios = Axios.create({ baseURL: proc.url })
  })

  afterEach(async () => {
    await stopProc(proc)
    await agent.stop()
  })

  it('maps an error span stack to the original TypeScript source', async () => {
    await Promise.all([
      agent.assertMessageReceived(({ payload }) => {
        const [span] = payload.flatMap(p => p.filter(s => s.name === 'fastify.request'))
        assert.ok(span, 'fastify.request span should be present')
        assert.strictEqual(span.error, 1)
        const stack = span.meta['error.stack']
        assert.match(stack, /throws\.ts:4:/)
        assert.doesNotMatch(stack, /throws\.js:/)
      }, 2_500),
      axios.get('/').catch(() => {}),
    ])
  })
})
