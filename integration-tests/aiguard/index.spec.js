'use strict'

const { describe, it, before, after } = require('mocha')
const path = require('path')
const { createSandbox, FakeAgent, spawnProc } = require('../helpers')
const startApiMock = require('./api-mock')
const { expect } = require('chai')
const { executeRequest } = require('./util')

describe('AIGuard SDK integration tests', () => {
  let sandbox, cwd, appFile, agent, proc, api, url

  before(async () => {
    sandbox = await createSandbox(['express'])
    cwd = sandbox.folder
    appFile = path.join(cwd, 'aiguard/server.js')
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

  const testSuite = [
    { endpoint: '/allow', action: 'ALLOW', reason: 'The prompt looks harmless' },
    { endpoint: '/deny', action: 'DENY', reason: 'I am feeling suspicious today' },
    { endpoint: '/abort', action: 'ABORT', reason: 'The user is trying to destroy me' }
  ].flatMap(r => [
    { ...r, blocking: true },
    { ...r, blocking: false },
  ])

  for (const { endpoint, action, reason, blocking } of testSuite) {
    it(`test evaluate with ${action} response (blocking ${blocking})`, async () => {
      const headers = blocking ? { 'x-blocking-enabled': true } : null
      const response = await executeRequest(`${url}${endpoint}`, 'GET', headers)
      if (blocking && action !== 'ALLOW') {
        expect(response.status).not.to.equal(200)
        expect(response.body).to.contain(reason)
      } else {
        expect(response.status).to.equal(200)
        expect(response.body).to.have.nested.property('action', action)
        expect(response.body).to.have.nested.property('reason', reason)
      }
      await agent.assertMessageReceived(({ headers, payload }) => {
        const span = payload[0].find(span => span.name === 'ai_guard')
        expect(span).not.to.be.null
      })
    })
  }
})
