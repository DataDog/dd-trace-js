'use strict'

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  spawnProc,
  curlAndAssertMessage,
  assertObjectContains
} = require('./helpers')
const path = require('path')
const { USER_KEEP } = require('../ext/priority')

describe('Log Injection', () => {
  let agent
  let proc
  let cwd
  let app
  let env

  useSandbox(['express', 'winston'])

  before(() => {
    cwd = sandboxCwd()
    app = path.join(cwd, 'log_injection/index.js')
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
  })

  describe('log injection with rule based sampling', () => {
    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('should correctly apply rule based sampling when log injection is enabled', async () => {
      env = {
        AGENT_PORT: agent.port,
        lOG_INJECTION: 'true'
      }
      proc = await spawnProc(app, { cwd, env, execArgv: [] })
      const url = proc.url + '/sampled'
      return curlAndAssertMessage(agent, url, ({ headers, payload }) => {
        // Bug: previously got USER_REJECT instead of USER_KEEP when log injection is enabled,
        // meaning resource rules are not applied & instead global sampling is applied
        // Now gets USER_KEEP because resource rules are applied
        assertObjectContains(payload, [[{ metrics: { _sampling_priority_v1: USER_KEEP } }]])
      }, 20000, 1)
    })

    it('should correctly apply rule based sampling when log injection is disabled', async () => {
      env = {
        AGENT_PORT: agent.port,
        lOG_INJECTION: 'false'
      }
      proc = await spawnProc(app, { cwd, env, execArgv: [] })
      const url = proc.url + '/sampled'
      return curlAndAssertMessage(agent, url, ({ headers, payload }) => {
        assertObjectContains(payload, [[{ metrics: { _sampling_priority_v1: USER_KEEP } }]])
      }, 20000, 1)
    })
  })
})
