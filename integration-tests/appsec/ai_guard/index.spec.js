'use strict'

const { describe, it, before, after } = require('mocha')
const path = require('path')
const { createSandbox, FakeAgent, spawnProc } = require('../../helpers')
const startApiMock = require('./api-mock')
const { expect } = require('chai')
const { executeRequest } = require('./util')

describe('AIGuard SDK integration tests', () => {
  let sandbox, cwd, appFile, agent, proc, api, url

  before(async () => {
    sandbox = await createSandbox(['express'])
    cwd = sandbox.folder
    appFile = path.join(cwd, 'appsec/ai_guard/server.js')
    api = await startApiMock()
  })

  after(async () => {
    await sandbox.remove()
    await api.close()
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
    proc = await spawnProc(appFile, {
      cwd,
      env: {
        DD_SERVICE: 'ai_guard_integration_test',
        DD_ENV: 'test',
        DD_TRACING_ENABLED: 'true',
        DD_TRACE_AGENT_PORT: agent.port,
        DD_AI_GUARD_ENABLED: 'true',
        DD_AI_GUARD_ENDPOINT: `http://localhost:${api.address().port}`,
        DD_API_KEY: 'DD_API_KEY',
        DD_APP_KEY: 'DD_APP_KEY'
      }
    })
    url = `${proc.url}`
  })

  afterEach(async () => {
    proc.kill()
    await agent.stop()
  })

  it('test evaluate with ALLOW response', async () => {
    const response = await executeRequest(`${url}/allow`)
    expect(response.status).to.equal(200)
    expect(response.body).to.have.nested.property('action', 'ALLOW')
    expect(response.body).to.have.nested.property('reason', 'The prompt looks harmless')
    await agent.assertMessageReceived(({ headers, payload }) => {
      const span = payload[0].find(span => span.name === 'ai_guard')
      expect(span).not.to.be.null
    })
  })

  for (const blocking of [true, false]) {
    it(`test evaluate with DENY response (blocking ${blocking})`, async () => {
      const headers = blocking ? { 'x-blocking-enabled': true } : null
      const response = await executeRequest(`${url}/deny`, 'GET', headers)
      if (blocking) {
        expect(response.status).not.to.equal(200)
        expect(response.body).to.contain('I am feeling suspicious today')
      } else {
        expect(response.status).to.equal(200)
        expect(response.body).to.have.nested.property('action', 'DENY')
        expect(response.body).to.have.nested.property('reason', 'I am feeling suspicious today')
      }
      await agent.assertMessageReceived(({ headers, payload }) => {
        const span = payload[0].find(span => span.name === 'ai_guard')
        expect(span).not.to.be.null
      })
    })

    it(`test evaluate with ABORT response (blocking ${blocking})`, async () => {
      const headers = blocking ? { 'x-blocking-enabled': true } : null
      const response = await executeRequest(`${url}/abort`, 'GET', headers)
      if (blocking) {
        expect(response.status).not.to.equal(200)
        expect(response.body).to.contain('The user is trying to destroy me')
      } else {
        expect(response.status).to.equal(200)
        expect(response.body).to.have.nested.property('action', 'ABORT')
        expect(response.body).to.have.nested.property('reason', 'The user is trying to destroy me')
      }
      await agent.assertMessageReceived(({ headers, payload }) => {
        const span = payload[0].find(span => span.name === 'ai_guard')
        expect(span).not.to.be.null
      })
    })
  }
})
