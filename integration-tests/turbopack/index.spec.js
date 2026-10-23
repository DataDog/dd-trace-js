'use strict'

const assert = require('node:assert/strict')
const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const {
  FakeAgent,
  checkSpansForServiceName,
  sandboxCwd,
  spawnProc,
  stopProc,
  useSandbox,
} = require('../helpers')
const httpRequest = require('../../packages/dd-trace/test/setup/helpers/http-client')

const scenarios = ['15.5.0', 'latest'].flatMap(nextVersion =>
  ['preloaded', 'bundled'].map(tracerMode => ({ nextVersion, tracerMode }))
)

for (const { nextVersion, tracerMode } of scenarios) {
  describe(`Turbopack integration with Next.js ${nextVersion} (${tracerMode} tracer)`, () => {
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
      execSync('npm exec -- next build --turbopack', {
        cwd: applicationDirectory,
        env: { ...process.env, DD_TEST_BUNDLED_TRACER: String(tracerMode === 'bundled') },
        stdio: 'inherit',
      })
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
      proc = await spawnProc(path.join(applicationDirectory, 'server.js'), {
        cwd: applicationDirectory,
        env: {
          ...process.env,
          DD_TEST_BUNDLED_TRACER: String(tracerMode === 'bundled'),
          DD_TRACE_AGENT_PORT: String(agent.port),
          DD_TRACE_FLUSH_INTERVAL: '0',
          NODE_OPTIONS: tracerMode === 'preloaded' ? '--import=dd-trace/init.js' : '',
        },
        execArgv: [],
      })
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    // A bundled tracer only starts in instrumentation.js, after Next.js has loaded these dependencies.
    if (tracerMode === 'preloaded') {
      it('instruments bundled CommonJS, ESM, and extensionless dependencies', async () => {
        const assertCommonJsTrace = agent.assertMessageReceived(({ payload }) => {
          assert.strictEqual(checkSpansForServiceName(payload, 'next.request'), true)
          assert.strictEqual(checkSpansForServiceName(payload, 'express.request'), true)
          assert.strictEqual(checkSpansForServiceName(payload, 'redis.command'), true)
        }, 10_000, 1, true)

        const [response] = await Promise.all([
          httpRequest.get(`${proc.url}/api/cjs`),
          assertCommonJsTrace,
        ])
        assert.deepStrictEqual(response.data, { value: 'extensionless' })

        const assertEsmTrace = agent.assertMessageReceived(({ payload }) => {
          assert.strictEqual(checkSpansForServiceName(payload, 'next.request'), true)
          assert.strictEqual(checkSpansForServiceName(payload, 'generateText'), true)
        }, 10_000, 1, true)

        const [esmResponse] = await Promise.all([
          httpRequest.get(`${proc.url}/api/esm`),
          assertEsmTrace,
        ])
        assert.deepStrictEqual(esmResponse.data, { text: 'ok' })
      })
    }

    // Built-ins the bundle loaded before a bundled tracer started must still be instrumented.
    for (const format of tracerMode === 'bundled' ? ['cjs', 'esm'] : []) {
      it(`instruments node:http and node:dns imported by ${format} routes`, async () => {
        const spans = []
        const assertBuiltinTrace = agent.assertMessageReceived(({ payload }) => {
          spans.push(...payload.flat())
          assert.ok(spans.some(span => span.name === 'next.request'))
          const server = spans.find(span => span.name === 'web.request' &&
            span.meta['http.url'].endsWith(`/api/builtins-${format}`))
          assert.ok(server, 'unbundled HTTP server control span')
          const client = spans.find(span => span.name === 'http.request' &&
            new URL(span.meta['http.url']).pathname === '/builtin-target')
          assert.ok(client, 'bundled http.request client span')
          assert.equal(client.meta['http.method'], 'GET')
          assert.equal(client.meta['http.status_code'], '200')
          assert.equal(client.error, 0)
          const dns = spans.find(span => span.name === 'dns.lookup' && span.resource === 'localhost')
          assert.ok(dns, 'bundled dns.lookup span')
          assert.equal(dns.meta['dns.address'], '127.0.0.1')
          assert.equal(dns.error, 0)
        }, 10_000, 1, true)

        const [response] = await Promise.all([
          httpRequest.get(`${proc.url}/api/builtins-${format}`),
          assertBuiltinTrace,
        ])
        assert.deepStrictEqual(response.data, { address: '127.0.0.1', body: 'builtin-ok' })
      })
    }
  })
}
