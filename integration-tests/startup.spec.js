'use strict'

const {
  FakeAgent,
  spawnProc,
  createSandbox,
  curlAndAssertMessage
} = require('./helpers')
const path = require('path')
const { assert } = require('chai')
const semver = require('semver')
const { inspect } = require('util')
const fs = require('fs')

const execArgvs = [
  {
    execArgv: []
  },
  {
    execArgv: ['--import', 'dd-trace/register.js'],
    skip: semver.satisfies(process.versions.node, '<20.6')
  },
  {
    execArgv: ['--loader', 'dd-trace/loader-hook.mjs'],
    skip: semver.satisfies(process.versions.node, '>=20.6')
  }
]

execArgvs.forEach(({ execArgv, skip }) => {
  const describe = skip ? globalThis.describe.skip : globalThis.describe

  describe(`startup ${execArgv.join(' ')}`, () => {
    let agent
    let proc
    let sandbox
    let cwd
    let startupTestFile
    let unsupportedTestFile

    before(async () => {
      sandbox = await createSandbox(['d3-format@3.1.0'])
      cwd = sandbox.folder
      startupTestFile = path.join(cwd, 'startup/index.js')
      unsupportedTestFile = path.join(cwd, 'startup/unsupported.js')
    })

    after(async () => {
      await sandbox.remove()
    })

    context('programmatic', () => {
      beforeEach(async () => {
        agent = await new FakeAgent().start()
      })

      afterEach(async () => {
        proc.kill()
        await agent.stop()
      })

      it('works for options.port', async () => {
        proc = await spawnProc(startupTestFile, {
          cwd,
          execArgv,
          env: {
            AGENT_PORT: agent.port
          }
        })
        return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
          assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
          assert.isArray(payload)
          assert.strictEqual(payload.length, 1)
          assert.isArray(payload[0])
          assert.strictEqual(payload[0].length, 1)
          assert.propertyVal(payload[0][0], 'name', 'web.request')
        })
      })

      it('saves tracer configuration on disk', async () => {
        if (process.platform !== 'linux') {
          return
        }

        proc = await spawnProc(startupTestFile, {
          cwd,
          execArgv,
          env: {
            AGENT_PORT: agent.port
          }
        })

        const containsDatadogMemfd = (fds) => {
          for (const fd of fds) {
            try {
              const fdName = fs.readlinkSync(`/proc/${proc.pid}/fd/${fd}`)
              if (fdName.includes('datadog-tracer-info-')) {
                return true
              }
            } catch {}
          }
          return false
        }

        const fds = fs.readdirSync(`/proc/${proc.pid}/fd`)

        assert(
          containsDatadogMemfd(fds),
          `FDs ${inspect(fds)} of PID ${proc.pid} did not contain the datadog tracer configuration in memfd`
        )
      })

      it('works for options.url', async () => {
        proc = await spawnProc(startupTestFile, {
          cwd,
          execArgv,
          env: {
            AGENT_URL: `http://localhost:${agent.port}`
          }
        })
        return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
          assert.propertyVal(headers, 'host', `localhost:${agent.port}`)
          assert.isArray(payload)
          assert.strictEqual(payload.length, 1)
          assert.isArray(payload[0])
          assert.strictEqual(payload[0].length, 1)
          assert.propertyVal(payload[0][0], 'name', 'web.request')
        })
      })
    })

    context('env var', () => {
      beforeEach(async () => {
        agent = await new FakeAgent().start()
      })

      afterEach(async () => {
        proc.kill()
        await agent.stop()
      })

      it('works for DD_TRACE_AGENT_PORT', async () => {
        proc = await spawnProc(startupTestFile, {
          cwd,
          execArgv,
          env: {
            DD_TRACE_AGENT_PORT: agent.port
          }
        })
        return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
          assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
          assert.isArray(payload)
          assert.strictEqual(payload.length, 1)
          assert.isArray(payload[0])
          assert.strictEqual(payload[0].length, 1)
          assert.propertyVal(payload[0][0], 'name', 'web.request')
        })
      })

      it('works for DD_TRACE_AGENT_URL', async () => {
        proc = await spawnProc(startupTestFile, {
          cwd,
          execArgv,
          env: {
            DD_TRACE_AGENT_URL: `http://localhost:${agent.port}`
          }
        })
        return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
          assert.propertyVal(headers, 'host', `localhost:${agent.port}`)
          assert.isArray(payload)
          assert.strictEqual(payload.length, 1)
          assert.isArray(payload[0])
          assert.strictEqual(payload[0].length, 1)
          assert.propertyVal(payload[0][0], 'name', 'web.request')
        })
      })
    })

    context('default', () => {
      beforeEach(async () => {
        // Note that this test will *always* listen on the default port. If that
        // port is unavailable, the test will fail.
        agent = await new FakeAgent(8126).start()
      })

      afterEach(async () => {
        proc.kill()
        await agent.stop()
      })

      it('works for hostname and port', async () => {
        proc = await spawnProc(startupTestFile, {
          cwd,
          execArgv
        })
        return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
          assert.propertyVal(headers, 'host', '127.0.0.1:8126')
          assert.isArray(payload)
          assert.strictEqual(payload.length, 1)
          assert.isArray(payload[0])
          assert.strictEqual(payload[0].length, 1)
          assert.propertyVal(payload[0][0], 'name', 'web.request')
        })
      })

      it('works with stealthy-require', async () => {
        proc = await spawnProc(startupTestFile, {
          cwd,
          execArgv,
          env: {
            STEALTHY_REQUIRE: 'true'
          }
        })
        return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
          assert.propertyVal(headers, 'host', '127.0.0.1:8126')
          assert.isArray(payload)
          assert.strictEqual(payload.length, 1)
          assert.isArray(payload[0])
          assert.strictEqual(payload[0].length, 1)
          assert.propertyVal(payload[0][0], 'name', 'web.request')
        })
      })
    })

    context('with unsupported module', () => {
      it('skips the unsupported module', async () => {
        await spawnProc(unsupportedTestFile, {
          cwd,
          execArgv
        })
      })
    })
  })
})
