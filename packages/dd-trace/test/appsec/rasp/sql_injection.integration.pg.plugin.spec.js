'use strict'

const assert = require('node:assert/strict')

const path = require('path')
const { inspect } = require('node:util')
const { sandboxCwd, useSandbox, FakeAgent, spawnProc, stopProc } = require('../../../../../integration-tests/helpers')
const HttpRequest = require('../../setup/helpers/http-client')
// These test are here and not in the integration tests
// because they require postgres instance
describe('RASP - sql_injection - integration', () => {
  let httpRequest, cwd, appFile, agent, proc

  useSandbox(
    ['express', 'pg'],
    false,
    [path.join(__dirname, 'resources')])

  before(function () {
    cwd = sandboxCwd()
    appFile = path.join(cwd, 'resources', 'postgress-app', 'index.js')
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
    proc = await spawnProc(appFile, {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent.port,
        DD_APPSEC_ENABLED: 'true',
        DD_APPSEC_RASP_ENABLED: 'true',
        DD_APPSEC_RULES: path.join(cwd, 'resources', 'rasp_rules.json'),
      },
    })
    httpRequest = HttpRequest.create({ baseURL: proc.url })
  })

  afterEach(async () => {
    await stopProc(proc)
    await agent.stop()
  })

  it('should block using pg.Client and unhandled promise', async () => {
    try {
      await httpRequest.get('/sqli/client/uncaught-promise?param=\' OR 1 = 1 --')
    } catch (e) {
      if (!e.response) {
        throw e
      }

      assert.strictEqual(e.response.status, 403)
      return await agent.assertMessageReceived(({ headers, payload }) => {
        assert.ok(
          Object.hasOwn(payload[0][0].meta, '_dd.appsec.json'),
          `Available keys: ${inspect(Object.keys(payload[0][0].meta))}`
        )
        assert.match(payload[0][0].meta['_dd.appsec.json'], /"rasp-sqli-rule-id-2"/)
      })
    }

    throw new Error('Request should be blocked')
  })

  it('should block using pg.Client and unhandled query object', async () => {
    try {
      await httpRequest.get('/sqli/client/uncaught-query-error?param=\' OR 1 = 1 --')
    } catch (e) {
      if (!e.response) {
        throw e
      }

      assert.strictEqual(e.response.status, 403)
      return await agent.assertMessageReceived(({ headers, payload }) => {
        assert.ok(
          Object.hasOwn(payload[0][0].meta, '_dd.appsec.json'),
          `Available keys: ${inspect(Object.keys(payload[0][0].meta))}`
        )
        assert.match(payload[0][0].meta['_dd.appsec.json'], /"rasp-sqli-rule-id-2"/)
      })
    }

    throw new Error('Request should be blocked')
  })

  it('should block using pg.Pool and unhandled promise', async () => {
    try {
      await httpRequest.get('/sqli/pool/uncaught-promise?param=\' OR 1 = 1 --')
    } catch (e) {
      if (!e.response) {
        throw e
      }

      assert.strictEqual(e.response.status, 403)
      return await agent.assertMessageReceived(({ headers, payload }) => {
        assert.ok(
          Object.hasOwn(payload[0][0].meta, '_dd.appsec.json'),
          `Available keys: ${inspect(Object.keys(payload[0][0].meta))}`
        )
        assert.match(payload[0][0].meta['_dd.appsec.json'], /"rasp-sqli-rule-id-2"/)
      })
    }

    throw new Error('Request should be blocked')
  })
})
