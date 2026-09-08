'use strict'

const assert = require('node:assert/strict')

const path = require('path')
const { inspect } = require('node:util')
const { sandboxCwd, useSandbox, spawnProc, FakeAgent, stopProc } = require('../helpers')
describe('ESM', () => {
  let cwd, appFile, agent, proc

  /**
   * @param {string} url
   */
  async function request (url) {
    const response = await fetch(new URL(url, proc.url))
    assert.strictEqual(response.status, 200)
    await response.arrayBuffer()
  }

  useSandbox(['express'])

  before(function () {
    cwd = sandboxCwd()
    appFile = path.join(cwd, 'appsec', 'esm-app', 'index.mjs')
  })

  const nodeOptionsList = [
    '--import dd-trace/initialize.mjs',
    '--require dd-trace/init.js --loader dd-trace/loader-hook.mjs',
    '--import dd-trace/register.js --require dd-trace/init',
  ]

  nodeOptionsList.forEach(nodeOptions => {
    describe(`with NODE_OPTIONS=${nodeOptions}`, () => {
      beforeEach(async () => {
        agent = await new FakeAgent().start()

        proc = await spawnProc(appFile, {
          cwd,
          env: {
            DD_TRACE_AGENT_PORT: agent.port,
            DD_IAST_ENABLED: 'true',
            DD_IAST_REQUEST_SAMPLING: '100',
            NODE_OPTIONS: nodeOptions,
          },
        })
      })

      afterEach(async () => {
        await stopProc(proc)
        await agent.stop()
      })

      function verifySpan (payload, verify) {
        let err
        for (let i = 0; i < payload.length; i++) {
          const trace = payload[i]
          for (let j = 0; j < trace.length; j++) {
            try {
              verify(trace[j])
              return
            } catch (e) {
              err = err || e
            }
          }
        }
        throw err
      }

      it('should detect COMMAND_INJECTION vulnerability', async function () {
        await request('/cmdi-vulnerable?args=-la')

        await agent.assertMessageReceived(({ payload }) => {
          verifySpan(payload, span => {
            assert.ok(Object.hasOwn(span.meta, '_dd.iast.json'), `Available keys: ${inspect(Object.keys(span.meta))}`)
            assert.match(span.meta['_dd.iast.json'], /"COMMAND_INJECTION"/)
          })
        }, null, 1, true)
      })

      it('should detect COMMAND_INJECTION vulnerability in imported file', async () => {
        await request('/more/cmdi-vulnerable?args=-la')

        await agent.assertMessageReceived(({ payload }) => {
          verifySpan(payload, span => {
            assert.ok(Object.hasOwn(span.meta, '_dd.iast.json'), `Available keys: ${inspect(Object.keys(span.meta))}`)
            assert.match(span.meta['_dd.iast.json'], /"COMMAND_INJECTION"/)
          })
        }, null, 1, true)
      })
    })
  })
})
