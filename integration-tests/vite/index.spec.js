'use strict'

const assert = require('node:assert/strict')
const { execSync } = require('node:child_process')
const path = require('node:path')

const semver = require('semver')

const {
  FakeAgent,
  checkSpansForServiceName,
  sandboxCwd,
  spawnProc,
  stopProc,
  useSandbox,
} = require('../helpers')
const httpRequest = require('../../packages/dd-trace/test/setup/helpers/http-client')

describe('Vite integration with dd-trace bundled without a plugin', () => {
  useSandbox(['vite'], false, [__dirname])

  let applicationDirectory

  before(function () {
    applicationDirectory = path.join(sandboxCwd(), 'vite')
    const { engines } = require(path.join(sandboxCwd(), 'node_modules', 'vite', 'package.json'))
    if (!semver.satisfies(process.versions.node, engines.node)) {
      // Release lines still testing older Node.js versions run this suite, but Vite does not support them.
      this.skip()
    }
  })

  for (const format of ['es', 'cjs']) {
    describe(`${format} output`, () => {
      let agent
      let proc

      before(function () {
        this.timeout(120_000)
        execSync('npm exec -- vite build', {
          cwd: applicationDirectory,
          env: { ...process.env, NODE_OPTIONS: '', VITE_OUTPUT_FORMAT: format },
          stdio: 'inherit',
        })
      })

      beforeEach(async () => {
        agent = await new FakeAgent().start()
        const entry = path.join(applicationDirectory, `dist-${format}`, format === 'es' ? 'server.mjs' : 'server.cjs')
        proc = await spawnProc(entry, {
          cwd: applicationDirectory,
          env: {
            ...process.env,
            NODE_OPTIONS: '',
            DD_TRACE_AGENT_PORT: String(agent.port),
            DD_TRACE_FLUSH_INTERVAL: '0',
          },
        })
      })

      afterEach(async () => {
        await stopProc(proc)
        await agent.stop()
      })

      it('starts the application and traces built-in modules', async () => {
        const assertTrace = agent.assertMessageReceived(({ payload }) => {
          assert.strictEqual(checkSpansForServiceName(payload, 'web.request'), true)
          assert.strictEqual(checkSpansForServiceName(payload, 'http.request'), true)
          assert.strictEqual(checkSpansForServiceName(payload, 'command_execution'), true)
        }, 10_000, 1, true)

        const [response] = await Promise.all([
          httpRequest.get(proc.url),
          assertTrace,
        ])
        assert.strictEqual(response.data, 'ok')
      })
    })
  }
})
